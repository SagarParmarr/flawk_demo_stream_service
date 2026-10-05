import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PersistentFactory, checkPersistentBinary } from '../src/integrations/ffmpeg/persistent.js';
import type { FastifyBaseLogger } from 'fastify';

async function helper() {
  const directory = await mkdtemp(path.join(tmpdir(),'publisher-adapter-'));
  const binary = path.join(directory,'helper.mjs');
  await writeFile(binary, `#!/usr/bin/env node
import readline from 'node:readline';
if(process.argv.includes('--version')){console.log(JSON.stringify({protocol:1}));process.exit(0);}
const emit=e=>console.log(JSON.stringify(e));
const pending=new Map();
readline.createInterface({input:process.stdin}).on('line',line=>{
 const command=JSON.parse(line);
 if(command.type==='start'){console.error(command.output);emit({event:'ready'});}
 if(command.type==='switch'){
   const result={event:'switch_committed',requestId:command.requestId,outputTimestamp:2};
   if(command.path.includes('committed')) {emit(result);pending.set(command.requestId,result);}
   else if(command.path.includes('fatal')) {emit({event:'fatal'});process.exit(1);}
   else pending.set(command.requestId,setTimeout(()=>{emit(result);pending.delete(command.requestId)},100));
 }
 if(command.type==='cancel'){
   const value=pending.get(command.requestId);
   if(value?.event)emit(value);
   else {clearTimeout(value);pending.delete(command.requestId);emit({event:'cancelled',requestId:command.requestId});}
 }
 if(command.type==='stop')process.exit(0);
});
`);
  await chmod(binary,0o755);
  return {directory,binary};
}
const media=(p:string)=>({path:p,hasAudio:true,durationSeconds:2,publishMode:'copy' as const,mediaProfile:'square800-copy-v2'});

test('persistent adapter reconciles committed cancellation and keeps secrets out of argv/logs', async () => {
  const h=await helper();
  const logs: unknown[]=[];
  const log={debug:(e:unknown)=>logs.push(e)} as unknown as FastifyBaseLogger;
  try {
    checkPersistentBinary(h.binary);
    const publisher=await new PersistentFactory(h.binary,log).start('/default.mp4',true,2,
      {ingest_server:'ivs.test',stream_key:'private-secret'},0);
    try {
      const cancelled=new AbortController();
      const request=publisher.switchSource!(media('/pending.mp4'),'cancel-id',cancelled.signal);
      cancelled.abort();
      await assert.rejects(request,/cancelled/);
      const raced=new AbortController();
      const commit=publisher.switchSource!(media('/committed.mp4'),'commit-id',raced.signal);
      raced.abort();
      assert.equal((await commit).outputTimestamp,2);
      assert.ok(publisher.alive());
      assert.ok(!JSON.stringify(logs).includes('private-secret'));
    } finally {await publisher.stop();}
    assert.equal(publisher.alive(),false);
  } finally {await rm(h.directory,{recursive:true,force:true});}
});

test('helper failure rejects a pending switch with a sanitized error', async () => {
  const h=await helper();
  try {
    const publisher=await new PersistentFactory(h.binary).start('/default.mp4',true,2,
      {ingest_server:'ivs.test',stream_key:'private-secret'},0);
    await assert.rejects(publisher.switchSource!(media('/fatal.mp4'),'fatal-id',new AbortController().signal),
      /Persistent publisher exited/);
    await publisher.stop();
  } finally {await rm(h.directory,{recursive:true,force:true});}
});
