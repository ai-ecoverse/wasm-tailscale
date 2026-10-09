import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { startTailnet, tailnetAvailable } from './tailnet.mjs';

if (!tailnetAvailable) {
  console.error('skip: set HEADSCALE, TAILSCALED and TAILSCALE to run the local tailnet test');
  process.exit(0);
}
const real = globalThis.process;
real.on('uncaughtException', (error) => {
  if (error?.code === 'UND_ERR_INFO') return;
  console.error(error);
  real.exit(1);
});
const tailnet = await startTailnet();
const done = async (code) => {
  await tailnet.close();
  real.exit(code);
};
try {
  const dir = new URL('../package/dist/', import.meta.url);
  const fake = Object.create(real);
  Object.defineProperty(fake, 'argv0', { value: 'browser' });
  globalThis.process = fake;
  (0, eval)(readFileSync(new URL('wasm_exec.js', dir), 'utf8'));
  const go = new globalThis.Go();
  go.env = { TS_DEBUG_USE_DERP_HTTP: '1' };
  void go.run((await WebAssembly.instantiate(readFileSync(new URL('main.wasm', dir)), go.importObject)).instance);
  while (typeof globalThis.newIPN !== 'function') await new Promise((resolve) => setTimeout(resolve, 10));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const state = new Map();
  const ipn = globalThis.newIPN({
    stateStorage: { getState: (k) => state.get(k) ?? '', setState: (k, v) => state.set(k, v) },
    hostname: 'wasm',
    controlURL: tailnet.controlURL,
    authKey: tailnet.key,
    ephemeral: true,
  });
  let running = false;
  ipn.run({
    notifyState: (s) => {
      if (s === 'NeedsLogin') ipn.login();
      if (s === 'Running') running = true;
    },
    notifyNetMap: () => {},
    notifyBrowseToURL: () => {},
    notifyPanicRecover: (error) => console.error(`panic: ${error}`),
  });
  for (let waited = 0; waited < 60000 && !running; waited += 100) await wait(100);
  assert.ok(running, 'joined the local tailnet');
  const status = JSON.parse(ipn.status());
  assert.equal(status.shieldsUp, true);
  const self = status.self.addresses[0];

  const readAll = async (conn) => {
    const bytes = [];
    for (let chunk = await conn.read(); chunk; chunk = await conn.read()) bytes.push(...chunk);
    return new TextDecoder().decode(new Uint8Array(bytes));
  };
  const web = new URL(tailnet.peer.web);
  const http = await ipn.dial('tcp', `${web.hostname}:${web.port}`);
  await http.write(new TextEncoder().encode('GET / HTTP/1.0\r\n\r\n'));
  assert.match(await readAll(http), /^HTTP\/1\.[01] 200[\s\S]*hello from the local tailnet/);
  http.close();

  const echo = await ipn.dial('tcp', tailnet.peer.echo);
  await echo.write(new TextEncoder().encode('hello'));
  echo.closeWrite();
  assert.equal(await readAll(echo), 'got hello then EOF', 'closeWrite reaches the peer as EOF');
  echo.close();

  const knock = (port) =>
    new Promise((resolve) => {
      const [bin, ...base] = tailnet.peer.cli.split(' ');
      const child = execFile(bin, [...base, 'nc', self, String(port)], { timeout: 10000 }, (error, out) =>
        resolve({ answered: out.length > 0, connected: !error })
      );
      child.stdin.write('GET / HTTP/1.0\r\n\r\n');
      setTimeout(() => child.stdin.end(), 4000);
    });
  for (const port of [80, 5710, 9222]) {
    const attempt = await knock(port);
    assert.equal(attempt.connected || attempt.answered, false, `nothing inbound on ${port}`);
  }

  const trace = async () => {
    const response = await ipn.fetch({ url: 'https://1.1.1.1/cdn-cgi/trace', method: 'GET', headers: [['user-agent', 'curl/8']] });
    const bytes = [];
    for (let chunk = await response.read(); chunk; chunk = await response.read()) bytes.push(...chunk);
    return new TextDecoder().decode(new Uint8Array(bytes));
  };
  await assert.rejects(trace(), 'no internet without an exit node');
  const exitId = JSON.parse(ipn.status()).peers.find((p) => p.exitNodeOption).id;
  for (const choice of ['exit', exitId]) {
    await ipn.setExitNode('');
    await ipn.setExitNode(choice);
    await wait(1500);
    assert.equal(JSON.parse(ipn.status()).exitNode?.name, 'exit', `exit node selected by ${choice}`);
  }
  const traced = await trace().catch((error) => `failed: ${error.message}`);
  console.error('TRACE', traced.slice(0, 200));
  assert.match(traced, /^ip=/m, 'the internet through the exit node');
  console.error('ok: joined a local headscale tailnet, dialled a peer, half-closed, nothing inbound, exit node by name and ID');
  await done(0);
} catch (error) {
  console.error(error);
  await done(1);
}
