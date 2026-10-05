import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SquarePreparation } from '../src/integrations/ffmpeg/square-preparation.js';
import { verifyCopyAsset } from '../src/integrations/ffmpeg/copy-validation.js';
const execute = promisify(execFile);
const binary = path.resolve('native/build/flawk-publisher');
const ffmpeg = 'ffmpeg';
const ffprobe = 'ffprobe';
interface Event { event: string; requestId: string; outputTimestamp: number; peakRssBytes?: number; reason?: string }
interface Packet { stream_index: number; pts_time: string; dts_time: string; duration_time: string; flags: string; data_hash: string }
async function packets(file: string): Promise<Packet[]> {
  const { stdout } = await execute(ffprobe, ['-v','error','-show_packets','-show_data_hash','sha256',
    '-show_entries','packet=stream_index,pts_time,dts_time,duration_time,flags,data_hash','-of','json',file], { maxBuffer: 32*1024*1024 });
  return JSON.parse(stdout).packets;
}

test('persistent copy output: 100 switches, loops, rejection, cancellation and continuous A/V', { timeout: 245000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'persistent-publisher-'));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const encoder = new SquarePreparation(ffmpeg, ffprobe);
    const assets: string[] = [];
    for (const color of ['red', 'blue']) {
      const input = path.join(dir, `${color}-source.mp4`);
      const output = path.join(dir, `${color}.mp4`);
      await execute(ffmpeg, ['-v','error','-y','-f','lavfi','-i',`color=${color}:size=320x180:rate=30`,
        '-f','lavfi','-i',`sine=frequency=${color === 'red' ? 440 : 880}:sample_rate=44100`,
        '-t','3','-c:v','libx264',...(color === 'red' ? ['-colorspace','bt470bg'] : []),'-c:a','aac',input]);
      await encoder.convert(input,output,await encoder.probe(input),.5,.5,undefined,'square800-copy-v2');
      assert.equal(await encoder.verify(output,undefined,'square800-copy-v2'),4);
      assets.push(output);
    }
    await assert.rejects(verifyCopyAsset(path.join(dir,'red-source.mp4'), binary));
    const reference = await Promise.all(assets.map(packets));
    const destination = path.join(dir,'output.flv');
    child = spawn(binary, ['--local-test'], { stdio: ['pipe','pipe','pipe'] });
    const pid = child.pid!;
    const events: Event[] = [];
    const commits: { event: Event; asset: number }[] = [];
    const requests = new Map<string,{ resolve: (e:Event)=>void; reject:(e:Error)=>void }>();
    let pendingText = '';
    let failure: Error | undefined;
    child.stderr!.resume();
    child.stdout!.on('data', (chunk:Buffer) => {
      pendingText += chunk.toString();
      const lines = pendingText.split('\n'); pendingText = lines.pop() ?? '';
      for (const line of lines) {
        const e = JSON.parse(line) as Event; events.push(e);
        if (e.event === 'fatal') failure = new Error(`Native failure: ${e.reason}`);
        const r = requests.get(e.requestId);
        if (r && ['switch_committed','switch_rejected','cancelled'].includes(e.event)) { requests.delete(e.requestId); r.resolve(e); }
      }
    });
    child.once('exit', () => { for (const r of requests.values()) r.reject(failure ?? new Error('Unexpected exit')); });
    const send = (object: object) => child!.stdin!.write(JSON.stringify(object)+'\n');
    const wait = async (predicate: () => boolean) => {
      const until=Date.now()+10000;
      while (!predicate()) { if (failure) throw failure; assert.ok(Date.now()<until,'native event timed out'); await new Promise(r=>setTimeout(r,10)); }
    };
    const request = (id:string, command:object) => new Promise<Event>((resolve,reject) => {
      requests.set(id,{resolve,reject}); send(command);
    });
    send({type:'start',path:assets[0],output:destination});
    await wait(()=>events.some(e=>e.event==='ready'));
    // Cross a natural loop before switching, without closing the output.
    await wait(()=>events.some(e=>e.event==='progress' && e.outputTimestamp>=4.5));
    const invalid = await request('bad',{type:'switch',requestId:'bad',path:path.join(dir,'red-source.mp4')});
    assert.equal(invalid.event,'switch_rejected');
    const cancelled = request('cancel-me',{type:'switch',requestId:'cancel-me',path:assets[1]});
    send({type:'cancel',requestId:'cancel-me'});
    assert.equal((await cancelled).event,'cancelled');
    const samples: number[] = [];
    for (let i=0;i<Number(process.env.NATIVE_PUBLISHER_SWITCHES ?? 100);i++) {
      const asset=(i+1)%2;
      const began=performance.now();
      const e=await request(`switch-${i}`,{type:'switch',requestId:`switch-${i}`,path:assets[asset]});
      assert.equal(e.event,'switch_committed');
      assert.ok(performance.now()-began<2100,'ready-to-commit exceeds 2.1s');
      commits.push({event:e,asset});
      assert.equal(child.pid,pid);
      if (i%10===0) {
        samples.push(events.filter(e=>e.event==='progress').at(-1)!.peakRssBytes! / 1024);
      }
    }
    await wait(()=>events.some(e=>e.event==='progress' && e.outputTimestamp>commits.at(-1)!.event.outputTimestamp+.1));
    send({type:'stop',requestId:'stop'});
    const code=await new Promise<number|null>(resolve=>child!.once('exit',resolve));
    assert.equal(code,0);
    assert.equal(events.filter(e=>e.event==='ready').length,1);
    // RSS in KiB; allow allocator warmup but reject growth with each asset switch.
    assert.ok(Math.max(...samples)-Math.min(...samples)<32*1024,'RSS grows across switches');
    const output=await packets(destination);
    for (const stream of [0,1]) {
      const track=output.filter(p=>p.stream_index===stream);
      assert.ok(track.length>0);
      for (let i=1;i<track.length;i++) {
        const gap=Number(track[i]!.dts_time)-Number(track[i-1]!.dts_time);
        assert.ok(gap>0 && gap<.035,`noncontinuous stream ${stream}: ${gap}`);
      }
    }
    const video=output.filter(p=>p.stream_index===0);
    const audio=output.filter(p=>p.stream_index===1);
    assert.ok(Math.abs(Number(video.at(-1)!.pts_time)-Number(audio.at(-1)!.pts_time))<.05);
    for (const {event:e,asset} of commits) {
      const first=video.find(p=>Math.abs(Number(p.pts_time)-e.outputTimestamp)<.001);
      assert.ok(first,`missing first picture for ${e.requestId} at ${e.outputTimestamp}`);
      assert.ok(first.flags.includes('K'),'incoming first packet must be a keyframe');
      assert.equal(first.data_hash,reference[asset]!.find(p=>p.stream_index===0)!.data_hash,
        'switch must copy the exact first encoded picture');
    }
    await execute(ffmpeg,['-v','error','-xerror','-i',destination,'-f','null','-'],{timeout:30000});
    t.diagnostic(`${commits.length} commits; one PID; ${video.length} video packets; RSS range ${Math.min(...samples)}–${Math.max(...samples)} KiB`);
  } finally {
    child?.kill('SIGKILL');
    await rm(dir,{recursive:true,force:true});
  }
});
