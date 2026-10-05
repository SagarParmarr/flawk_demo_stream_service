import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePersistentFlag } from '../src/infrastructure/config.js';
import { preparationArgs } from '../src/integrations/ffmpeg/square-preparation.js';
import { validatePreparationJob } from '../src/integrations/s3/preparation-storage.js';

test('persistent feature flag is strict and disabled by default', () => {
  assert.equal(parsePersistentFlag(undefined),false);
  assert.equal(parsePersistentFlag('false'),false);
  assert.equal(parsePersistentFlag('true'),true);
  for (const value of ['', '1','TRUE',' true ','yes']) assert.throws(()=>parsePersistentFlag(value));
});

test('v2 preparation is explicitly selected and completes the final GOP offline', () => {
  const legacy=preparationArgs('source','output',true,3,.5,.5);
  const copy=preparationArgs('source','output',true,3,.5,.5,2,'square800-copy-v2');
  assert.ok(!legacy.includes('-bf') && !legacy.includes('-tune'));
  assert.equal(legacy[legacy.indexOf('-t')+1],'3');
  assert.equal(copy[copy.indexOf('-t')+1],'4');
  assert.equal(copy[copy.indexOf('-bf')+1],'0');
  assert.equal(copy[copy.indexOf('-refs')+1],'1');
  assert.equal(copy[copy.indexOf('-level:v')+1],'3.2');
  assert.ok(copy.includes('zerolatency'));
  const token='12345678-1234-1234-1234-123456789012';
  const job={asset_id:1,generation:token,token,attempt:1,requested_at:new Date().toISOString(),
    source_s3_uri:'s3://source/source.mp4',output_bucket:'output',
    output_key:`flawk_cms/adaptive_assets/1/prepared/square800-copy-v2/${token}-${token}.mp4`,
    crop_x:.5,crop_y:.5,media_profile:'square800-copy-v2' as const};
  validatePreparationJob(job,'output',['source']);
  assert.throws(()=>validatePreparationJob({...job,output_key:job.output_key.replace('copy-v2','v1')},'output',['source']));
});
