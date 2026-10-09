import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dir = new URL('../package/dist/', import.meta.url);
const fake = Object.create(globalThis.process);
Object.defineProperty(fake, 'argv0', { value: 'browser' });
globalThis.process = fake;
(0, eval)(readFileSync(new URL('wasm_exec.js', dir), 'utf8'));
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(readFileSync(new URL('main.wasm', dir)), go.importObject);
void go.run(instance);
while (typeof globalThis.newIPN !== 'function') await new Promise((resolve) => setTimeout(resolve, 10));

const state = new Map();
const ipn = globalThis.newIPN({
  stateStorage: { getState: (k) => state.get(k) ?? '', setState: (k, v) => state.set(k, v) },
  hostname: 'wasm-tailscale-smoke',
});
const timer = setTimeout(() => {
  console.error('no login URL within 60 s');
  globalThis.process.exit(1);
}, 60000);
ipn.run({
  notifyState: (s) => {
    if (s === 'NeedsLogin') ipn.login();
  },
  notifyNetMap: () => {},
  notifyBrowseToURL: (url) => {
    clearTimeout(timer);
    const status = JSON.parse(ipn.status());
    assert.match(url, /^https:\/\/login\.tailscale\.com\//);
    assert.equal(status.shieldsUp, true);
    for (const name of ['fetch', 'dial', 'setExitNode', 'status', 'login'])
      assert.equal(typeof ipn[name], 'function', name);
    console.log(`ok: reached the control plane, shields up, ${state.size} state keys`);
    globalThis.process.exit(0);
  },
  notifyPanicRecover: (error) => {
    console.error(`panic: ${error}`);
    globalThis.process.exit(1);
  },
});
