import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dir = new URL('../package/dist/', import.meta.url);
const fake = Object.create(globalThis.process);
Object.defineProperty(fake, 'argv0', { value: 'browser' });
globalThis.process = fake;
(0, eval)(readFileSync(new URL('wasm_exec.js', dir), 'utf8'));
const go = new globalThis.Go();
const exited = go.run(
  (await WebAssembly.instantiate(readFileSync(new URL('main.wasm', dir)), go.importObject)).instance
);
let ended = false;
void exited.then(() => {
  ended = true;
});
while (typeof globalThis.newIPN !== 'function') await new Promise((resolve) => setTimeout(resolve, 10));

const state = new Map();
let setThrows = 1;
let getThrows = 1;
const ipn = globalThis.newIPN({
  stateStorage: {
    getState: (k) => {
      if (getThrows-- > 0) throw new Error('getState blew up');
      return state.get(k) ?? '';
    },
    setState: (k, v) => {
      if (setThrows-- > 0) throw new Error('setState blew up');
      state.set(k, v);
    },
  },
  hostname: 'wasm-tailscale-throwing',
});

const recovered = [];
let thrown = false;
let browsed = null;
ipn.run({
  notifyState: (s) => {
    if (s === 'NeedsLogin' && !thrown) {
      thrown = true;
      throw new Error('callback blew up');
    }
    if (s === 'NeedsLogin') ipn.login();
  },
  notifyNetMap: () => {},
  notifyBrowseToURL: (url) => {
    browsed = url;
  },
  notifyPanicRecover: (error) => recovered.push(error),
});
for (let waited = 0; waited < 8000 && recovered.length === 0; waited += 100)
  await new Promise((resolve) => setTimeout(resolve, 100));
assert.equal(ended, false, 'the Go program is still running');
assert.equal(thrown, true, 'notifyState threw once');
assert.ok(recovered.some((e) => e.includes('callback blew up')), 'notifyPanicRecover reported it');
const status = JSON.parse(ipn.status());
assert.ok(['NeedsLogin', 'NoState', 'Starting'].includes(status.state), `status works afterwards (${status.state})`);
ipn.login();
for (let waited = 0; waited < 30000 && !browsed; waited += 100)
  await new Promise((resolve) => setTimeout(resolve, 100));
assert.match(browsed ?? '', /^https:\/\/login\.tailscale\.com\//, 'it still logs in after the throws');
assert.equal(ended, false);
assert.ok(getThrows < 0 && setThrows < 0, 'both stateStorage callbacks threw once');
console.error('ok: throwing notify and stateStorage callbacks are survived, reported, and the node still logs in');
globalThis.process.exit(0);
