import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scenario = process.argv[2] ?? 'newipn';
const dir = new URL('../package/dist/', import.meta.url);
const fake = Object.create(globalThis.process);
Object.defineProperty(fake, 'argv0', { value: 'browser' });
globalThis.process = fake;
(0, eval)(readFileSync(new URL('wasm_exec.js', dir), 'utf8'));
const go = new globalThis.Go();
let ended = false;
void go
  .run((await WebAssembly.instantiate(readFileSync(new URL('main.wasm', dir)), go.importObject)).instance)
  .then(() => {
    ended = true;
  });
while (typeof globalThis.newIPN !== 'function') await new Promise((resolve) => setTimeout(resolve, 10));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const state = new Map();
let broken = scenario === 'newipn';
let browsedTo = () => {};

const ipn = globalThis.newIPN({
  stateStorage: {
    getState: (k) => {
      if (broken) throw new Error('storage is broken');
      return state.get(k) ?? '';
    },
    setState: (k, v) => {
      if (broken) throw new Error('storage is broken');
      state.set(k, v);
    },
  },
  hostname: 'wasm-tailscale-storage',
});

if (scenario === 'newipn') {
  assert.ok(ipn instanceof Error, 'newIPN returns an Error when its storage fails');
  assert.match(ipn.message, /^newIPN: /);
  await wait(500);
  assert.equal(ended, false, 'the Go program is still running');
  console.error(`ok: newIPN with broken storage returns "${ipn.message.slice(0, 70)}…" and the program lives`);
} else {
  broken = true;
  const recovered = [];
  ipn.run({
    notifyState: () => {},
    notifyNetMap: () => {},
    notifyBrowseToURL: (u) => browsedTo(u),
    notifyPanicRecover: (error) => recovered.push(error),
  });
  for (let waited = 0; waited < 8000 && recovered.length === 0; waited += 100) await wait(100);
  console.error(`state ${JSON.parse(ipn.status()).state}, recovered: ${recovered.join(' | ').slice(0, 160)}`);
  assert.ok(recovered.some((e) => e.startsWith('Tailscale could not start: ')), 'a failed start is reported');
  assert.equal(ended, false, 'the Go program is still running');
  const before = recovered.length;
  ipn.login();
  for (let waited = 0; waited < 8000 && recovered.length === before; waited += 100) await wait(100);
  assert.equal(ended, false, 'login() after a failed start does not end the program');
  assert.ok(recovered.length > before, 'login() with storage still broken reports the failure again');
  broken = false;
  let url = null;
  const watch = setInterval(() => {
    const st = JSON.parse(ipn.status());
    if (st.state === 'NeedsLogin' && !url) url = 'needs-login';
  }, 200);
  browsedTo = (u) => {
    url = u;
  };
  ipn.login();
  for (let waited = 0; waited < 30000 && !(url ?? '').startsWith('https://'); waited += 100) await wait(100);
  clearInterval(watch);
  assert.match(url ?? '', /^https:\/\/login\.tailscale\.com\//, 'with storage restored, login() reaches NeedsLogin with a URL');
  assert.equal(JSON.parse(ipn.status()).state, 'NeedsLogin');
  assert.equal(ended, false);
  console.error('ok: a start whose storage fails is reported, login() retries it, and works once storage recovers');
}
globalThis.process.exit(0);
