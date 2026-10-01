import assert from 'node:assert/strict';
import test from 'node:test';
import { loadMediaWorkerConfig } from '../src/infrastructure/media-config.js';

test('media worker permits local CMS development and rejects insecure remote API URLs', () => {
  const original = { ...process.env };
  try {
    process.env.DEMO_STREAM_SERVICE_SECRET = 'x'.repeat(32);
    process.env.MEDIA_OUTPUT_BUCKET = 'test-bucket';
    for (const url of ['https://cms.test', 'http://localhost:8484', 'http://127.0.0.1:8484', 'http://[::1]:8484']) {
      process.env.LARAVEL_API_BASE_URL = url;
      assert.equal(loadMediaWorkerConfig().laravelBaseUrl, url);
    }
    for (const url of ['http://cms.test', 'https://user:password@cms.test', 'https://cms.test?token=secret', 'https://cms.test#fragment']) {
      process.env.LARAVEL_API_BASE_URL = url;
      assert.throws(() => loadMediaWorkerConfig(), /Invalid media worker API configuration/);
    }
    process.env.LARAVEL_API_BASE_URL = 'https://cms.test';
    delete process.env.MEDIA_OUTPUT_BUCKET;
    assert.throws(() => loadMediaWorkerConfig(), /MEDIA_OUTPUT_BUCKET is required/);
  } finally { process.env = original; }
});
