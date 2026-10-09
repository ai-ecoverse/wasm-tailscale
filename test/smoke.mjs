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

const CONTROL = 'https://login.tailscale.com';
const state = new Map();
let ipn;
let insideStorage = null;
ipn = globalThis.newIPN({
  stateStorage: {
    getState: (k) => state.get(k) ?? '',
    setState: (k, v) => {
      state.set(k, v);
      if (ipn && insideStorage === null) insideStorage = ipn.status();
    },
  },
  hostname: 'wasm-tailscale-smoke',
  controlURL: CONTROL,
});

ipn.login('tskey-auth-not-a-real-key');
ipn.login();
await new Promise((resolve) => setTimeout(resolve, 2000));
assert.equal(JSON.parse(ipn.status()).state, 'NoState', 'login before run must not start the backend');

const fail = (message) => {
  console.error(message);
  globalThis.process.exit(1);
};
const timer = setTimeout(() => fail('no login URL within 60 s'), 60000);
let reentered = false;

function browsed(url) {
  clearTimeout(timer);
  const status = JSON.parse(ipn.status());
  assert.match(url, /^https:\/\/login\.tailscale\.com\//);
  assert.equal(reentered, true, 'status() worked from inside notifyState');
  assert.ok(insideStorage instanceof Error, 'status() inside a stateStorage callback returns an Error instead of hanging');
  assert.match(insideStorage.message, /called from inside a stateStorage callback/);
  assert.equal(status.shieldsUp, true, 'shields up after a login that was attempted before run');
  assert.equal(status.controlURL, CONTROL);
  for (const name of ['fetch', 'dial', 'setExitNode', 'status', 'login'])
    assert.equal(typeof ipn[name], 'function', name);
  ipn.logout();
  setTimeout(() => {
    const after = JSON.parse(ipn.status());
    assert.equal(after.shieldsUp, true, 'shields up after logout');
    assert.equal(after.controlURL, CONTROL, 'the configured control server after logout');
    console.log(
      `ok: control plane reached, login refused before run, status() safe in notify callbacks and failing fast in stateStorage ones, shields up and ${CONTROL} before and after logout`
    );
    globalThis.process.exit(0);
  }, 4000);
}

ipn.run({
  notifyState: (s) => {
    if (s !== 'NeedsLogin') return;
    if (!reentered) {
      assert.equal(JSON.parse(ipn.status()).state, 'NeedsLogin', 'notify callbacks run on their own task');
      reentered = true;
    }
    ipn.login();
  },
  notifyNetMap: () => {},
  notifyBrowseToURL: (url) => setTimeout(() => browsed(url), 0),
  notifyPanicRecover: (error) => fail(`panic: ${error}`),
});
