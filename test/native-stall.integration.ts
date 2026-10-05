import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Socket } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SquarePreparation } from '../src/integrations/ffmpeg/square-preparation.js';
const execute=promisify(execFile);

test('native RTMPS connection deadline exits a stalled TLS handshake without leaking credentials', {timeout:15000}, async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'native-stall-'));
  const sockets: Socket[]=[];
  const server=createServer(socket=>sockets.push(socket));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    try {await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}
    catch (e) {
      if (['EPERM','EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) {t.skip('Local listener unavailable in sandbox');return;}
      throw e;
    }
    const input=path.join(dir,'input.mp4'), asset=path.join(dir,'asset.mp4');
    await execute('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x180:rate=30','-t','2','-c:v','libx264',input]);
    const encoder=new SquarePreparation('ffmpeg','ffprobe');
    await encoder.convert(input,asset,await encoder.probe(input),.5,.5,undefined,'square800-copy-v2');
    const address=server.address();assert.ok(address && typeof address!=='string');
    const start=performance.now();
    child=spawn(path.resolve('native/build/flawk-publisher'),[],{stdio:['pipe','pipe','pipe']});
    let output='',stderr='';
    child.stdout!.on('data',c=>{output+=c;});child.stderr!.on('data',c=>{stderr+=c;});
    const timer=setTimeout(()=>child!.kill('SIGKILL'),7000);
    child.stdin!.write(JSON.stringify({type:'start',path:asset,output:`rtmps://127.0.0.1:${address.port}/app/private-secret`})+'\n');
    const code=await new Promise<number|null>(resolve=>child!.once('exit',resolve));
    clearTimeout(timer);
    assert.equal(code,1);
    assert.ok(performance.now()-start<6500);
    assert.ok(output.includes('fatal'));
    assert.ok(!output.includes('private-secret') && !stderr.includes('private-secret'));
  } finally {
    child?.kill('SIGKILL');for (const socket of sockets)socket.destroy();
    if (server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});
