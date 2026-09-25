import assert from 'node:assert/strict';
import test from 'node:test';
import { ingestUrl } from '../src/integrations/ffmpeg/process.js';

const ingest = {
  ingest_server: 'example.global-contribute.live-video.net',
  stream_key: 'sk_test/key',
};

test('initial IVS publisher omits takeover priority', () => {
  assert.equal(
    ingestUrl(ingest, 0),
    'rtmps://example.global-contribute.live-video.net:443/app/sk_test%2Fkey',
  );
});

test('replacement IVS publisher uses a positive takeover priority', () => {
  assert.equal(
    ingestUrl(ingest, 2),
    'rtmps://example.global-contribute.live-video.net:443/app/sk_test%2Fkey?priority=2',
  );
});
