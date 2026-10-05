import { spawn } from 'node:child_process';
import path from 'node:path';

// Share the native validator with offline preparation, cache admission and live switching.
// Paths and library diagnostics stay private; never include stdout/stderr in thrown errors.
export async function verifyCopyAsset(input: string, binary: string, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let valid = false;
    let buffer = '';
    const stop = () => { child.kill('SIGKILL'); };
    const timer = setTimeout(stop, 60000);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 65536) { stop(); return; }
      for (const line of buffer.split('\n').slice(0, -1)) {
        try { if (JSON.parse(line).event === 'valid') valid = true; } catch { /* Reject at exit. */ }
      }
      buffer = buffer.split('\n').at(-1) ?? '';
    });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
    child.once('error', () => { cleanup(); reject(new Error('Copy-profile validator is unavailable')); });
    child.once('exit', code => {
      cleanup();
      if (code === 0 && valid && !signal?.aborted) resolve();
      else reject(new Error('Prepared asset does not match square800-copy-v2'));
    });
    child.stdin.end(`${JSON.stringify({ type: 'validate', path: path.resolve(input) })}\n`);
    if (signal?.aborted) stop();
  });
}
