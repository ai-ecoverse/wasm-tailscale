import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const dir = new URL('../package/dist', import.meta.url).pathname;
const out = '/tmp/logout-check.out';
writeFileSync(out, '');
const say = (line) => { appendFileSync(out, `${line}\n`); console.error(`>> ${line}`); };
const fake = Object.create(globalThis.process);
Object.defineProperty(fake, 'argv0', { value: 'browser' });
globalThis.process = fake;
(0, eval)(readFileSync(`${dir}/wasm_exec.js`, 'utf8'));
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(readFileSync(`${dir}/main.wasm`), go.importObject);
void go.run(instance);
while (typeof globalThis.newIPN !== 'function') await new Promise((r) => setTimeout(r, 10));
const CONTROL = 'https://login.tailscale.com';
const state = {};
const ipn = globalThis.newIPN({
  stateStorage: { getState: (k) => state[k] ?? '', setState: (k, v) => { state[k] = v; } },
  hostname: 'slicc-logout-check', ephemeral: true, controlURL: CONTROL,
});
const status = () => JSON.parse(ipn.status());
let phase = 1;
let waiting = null;
const when = (want) => new Promise((resolve) => { waiting = { want, resolve }; });
ipn.run({
  notifyState: (s) => {
    say(`state ${s}`);
    if (waiting?.want === s) setTimeout(waiting.resolve, 0);
    if (s === 'NeedsLogin') setTimeout(() => ipn.login(), 0);
  },
  notifyNetMap: () => {},
  notifyBrowseToURL: (url) => say(`SIGN-IN ${phase} ${url}`),
  notifyPanicRecover: (e) => say(`panic ${e}`),
});
await when('Running');
let s = status();
say(`joined: shieldsUp=${s.shieldsUp} controlURL=${s.controlURL} self=${s.self?.addresses?.[0]}`);
phase = 2;
ipn.logout();
await when('NeedsLogin');
await new Promise((r) => setTimeout(r, 1500));
s = status();
say(`after logout: shieldsUp=${s.shieldsUp} controlURL=${s.controlURL}`);
await when('Running');
await new Promise((r) => setTimeout(r, 1500));
s = status();
say(`rejoined: shieldsUp=${s.shieldsUp} controlURL=${s.controlURL} self=${s.self?.addresses?.[0]}`);
say(s.shieldsUp === true && s.controlURL === CONTROL ? 'RESULT PASS' : 'RESULT FAIL');
ipn.logout();
setTimeout(() => globalThis.process.exit(0), 3000);
