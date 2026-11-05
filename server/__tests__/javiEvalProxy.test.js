// The Javi eval's recording proxy forwards only the Ollama paths Burrow uses and refuses the rest.
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRecordingProxy } from '../../scripts/lib/javiEval/ollamaProxy.js';

let upstream;
let seen;
let proxy;
let calls;

beforeEach(async () => {
  seen = [];
  calls = [];
  upstream = http.createServer((req, res) => {
    seen.push(req.url);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}\n');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  proxy = await startRecordingProxy({
    upstream: `http://127.0.0.1:${upstream.address().port}`,
    allowModel: 'tiny:1b',
    onCall: (r) => calls.push(r),
  });
});

afterEach(async () => {
  await proxy.close();
  await new Promise((resolve) => upstream.close(resolve));
});

const send = (path, body) =>
  fetch(`${proxy.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

describe('eval proxy path allowlist', () => {
  it.each(['/api/tags', '/api/show', '/api/version', '/api/ps'])('forwards %s', async (path) => {
    expect((await send(path)).status).toBe(200);
    expect(seen).toEqual([path]);
  });

  it('forwards /api/chat for the model under test only', async () => {
    expect((await send('/api/chat', { model: 'tiny:1b', messages: [] })).status).toBe(200);
    expect((await send('/api/chat', { model: 'huge:70b', messages: [] })).status).toBe(403);
    expect(seen).toEqual(['/api/chat']);
  });

  it.each(['/api/pull', '/api/generate', '/api/embed', '/api/delete', '/api/create', '/api/push', '/api/copy', '/'])('refuses %s with 403 and never reaches Ollama', async (path) => {
    expect((await send(path, { model: 'tiny:1b' })).status).toBe(403);
    expect(seen).toEqual([]);
    expect(calls.at(-1).refused).toBeTruthy();
  });
});
