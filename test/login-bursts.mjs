import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const scenario = process.argv[2] ?? 'healthy';
const dir = new URL('../package/dist/', import.meta.url);
globalThis.process.on('uncaughtException', (error) => {
  if (error?.code === 'UND_ERR_INFO') return;
  console.error(error);
  globalThis.process.exit(1);
});
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
let broken = false;
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
  hostname: 'wasm-tailscale-bursts',
});
const recovered = [];
let url = null;
if (scenario === 'failed-start') broken = true;
ipn.run({
  notifyState: () => {},
  notifyNetMap: () => {},
  notifyBrowseToURL: (u) => {
    url = u;
  },
  notifyPanicRecover: (error) => recovered.push(error),
});
await wait(scenario === 'failed-start' ? 3000 : 1500);
if (scenario === 'failed-start') assert.ok(recovered.some((e) => e.startsWith('Tailscale could not start')));

const KEY = 'tskey-auth-not-a-real-key';
const bursts = scenario === 'failed-start' ? [['l', 'k', 'l', 'l']] : [['l', 'k', 'l'], ['l', 'l', 'k', 'l']];
for (const burst of bursts) {
  for (const step of burst) (step === 'k' ? ipn.login(KEY) : ipn.login());
  await wait(4000);
  assert.equal(ended, false, `the program survives ${burst.join(',')}`);
}
if (scenario === 'failed-start') {
  broken = false;
  ipn.login();
}
for (let waited = 0; waited < (scenario === 'failed-start' ? 30000 : 5000) && !url; waited += 200) await wait(200);
assert.equal(ended, false);
assert.equal(JSON.parse(ipn.status()).state, 'NeedsLogin');
if (scenario === 'failed-start') assert.match(url ?? '', /^https:\/\/login\.tailscale\.com\//);
console.error(
  `ok: login bursts (${bursts.map((b) => b.join(',')).join(' then ')}) on a ${scenario} node: alive, NeedsLogin${url ? ' with a URL' : ' (the bad key is retried, as upstream does)'}`
);
globalThis.process.exit(0);
