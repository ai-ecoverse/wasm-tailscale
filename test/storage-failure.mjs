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
    notifyBrowseToURL: () => {},
    notifyPanicRecover: (error) => recovered.push(error),
  });
  for (let waited = 0; waited < 8000 && recovered.length === 0; waited += 100) await wait(100);
  console.error(`state ${JSON.parse(ipn.status()).state}, recovered: ${recovered.join(' | ').slice(0, 160)}`);
  assert.ok(recovered.some((e) => e.startsWith('Tailscale could not start: ')), 'a failed start is reported');
  assert.equal(ended, false, 'the Go program is still running');
  console.error('ok: a start whose storage fails is reported through notifyPanicRecover');
}
globalThis.process.exit(0);
