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

let prefsChanges = 0;
const log = console.log;
console.log = (...args) => {
  if (String(args[0]).includes('NOTIFY: Notify{Prefs{')) prefsChanges += 1;
  log(...args);
};
const state = new Map();
const ipn = globalThis.newIPN({
  stateStorage: { getState: (k) => state.get(k) ?? '', setState: (k, v) => state.set(k, v) },
  hostname: 'wasm-tailscale-empty-control',
  controlURL: '',
});
ipn.run({ notifyState: () => {}, notifyNetMap: () => {}, notifyBrowseToURL: () => {}, notifyPanicRecover: () => {} });
await new Promise((resolve) => setTimeout(resolve, 5000));
const status = JSON.parse(ipn.status());
assert.equal(status.controlURL, 'https://controlplane.tailscale.com');
assert.ok(prefsChanges < 5, `prefs keep changing (${prefsChanges} notifications in 5 s)`);
console.error(`ok: empty controlURL is the default control server, ${prefsChanges} prefs notifications`);
globalThis.process.exit(0);
