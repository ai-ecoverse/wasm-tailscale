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
  // The module's own control and DERP connections use the JS WebSocket;
  // websocket() must never: it goes through the netstack.
  const browserSockets = [];
  const NativeWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      browserSockets.push(String(url));
      super(url, protocols);
    }
  };
  const go = new globalThis.Go();
  go.env = { TS_DEBUG_USE_DERP_HTTP: '1' };
  const { instance } = await WebAssembly.instantiate(readFileSync(new URL('main.wasm', dir)), go.importObject);
  void go.run(instance);
  const memory = () => instance.exports.mem.buffer.byteLength;
  const MiB = 1024 * 1024;
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

  const hopByHop = [
    ['Proxy-Authorization', 'Basic cHJveHk6c2VjcmV0'],
    ['proxy-authenticate', 'Basic realm="x"'],
    ['TE', 'trailers'],
    ['Trailer', 'X-Late'],
    ['Keep-Alive', 'timeout=5'],
    ['Connection', 'close, X-Named-Hop'],
    ['X-Named-Hop', 'dropped'],
    ['x-kept', 'kept'],
  ];
  const assertNoHopByHop = (seen, where) => {
    for (const name of ['proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'keep-alive', 'x-named-hop'])
      assert.equal(seen[name], undefined, `${where} drops ${name}`);
    assert.equal(seen['x-kept'], 'kept', `${where} keeps an end-to-end header`);
  };
  const echoed = await ipn.fetch({ url: `${tailnet.peer.web}headers`, method: 'GET', headers: hopByHop });
  assertNoHopByHop(JSON.parse(await readAll(echoed)), 'fetch');

  const echo = await ipn.dial('tcp', tailnet.peer.echo);
  await echo.write(new TextEncoder().encode('hello'));
  echo.closeWrite();
  assert.equal(await readAll(echo), 'got hello then EOF', 'closeWrite reaches the peer as EOF');
  echo.close();

  // websocket(): by address and by MagicDNS name, to an echo server on the peer.
  const peerDNS = JSON.parse(ipn.status()).peers.find((p) => p.name === 'peer').dnsName.replace(/\.$/, '');
  const wsPort = tailnet.peer.wsPort;
  const next = async (ws) => {
    const { value, done } = await ws.messages.next();
    assert.equal(done, false, 'a message, not the end');
    return value;
  };
  for (const host of [tailnet.peer.ip, peerDNS]) {
    const base = `ws://${host}:${wsPort}`;
    const ws = await ipn.websocket({
      url: `${base}/echo`,
      protocols: ['nope', 'chat.v2'],
      headers: [
        ['x-slicc', 'yes'],
        ['origin', 'https://slicc.test'],
        ['cookie', 'session=secret'],
        ['host', 'elsewhere.example'],
        ['sec-websocket-key', 'bogus'],
        ['connection', 'close'],
        ['upgrade', 'h2c'],
        ...hopByHop,
      ],
    });
    assert.equal(ws.protocol, 'chat.v2', `the chosen subprotocol (${host})`);
    assert.equal(ws.send('hello'), undefined);
    assert.equal(await next(ws), 'hello', `text (${host})`);
    ws.send(new Uint8Array([0, 1, 2, 255]));
    const binary = await next(ws);
    assert.ok(binary instanceof Uint8Array, 'binary arrives as a Uint8Array');
    assert.deepEqual([...binary], [0, 1, 2, 255], `binary (${host})`);
    ws.send(new Uint16Array([0x0102]).buffer);
    assert.equal((await next(ws)).length, 2, 'an ArrayBuffer is sent as binary');
    ws.send('headers');
    const seen = JSON.parse(await next(ws));
    assert.equal(seen['x-slicc'], 'yes', 'headers pass through');
    assert.equal(seen.origin, 'https://slicc.test');
    assert.equal(seen.cookie, undefined, 'no Cookie');
    assert.equal(seen.host, `${host}:${wsPort}`, 'Host is the URL’s');
    assert.notEqual(seen['sec-websocket-key'], 'bogus', 'Sec-WebSocket-* are the handshake’s own');
    assert.equal(seen.upgrade, 'websocket');
    assertNoHopByHop(seen, `websocket (${host})`);
    ws.send('ping-me');
    assert.equal(await next(ws), 'pong received', 'a ping is answered in Go and never surfaced');
    ws.send('fragments');
    assert.equal(await next(ws), 'fragmented', 'fragments arrive as one message');
    const big = 'x'.repeat(1 << 20);
    ws.send(big);
    assert.ok(ws.buffered > 0 && ws.buffered <= big.length, `buffered counts unsent bytes (${ws.buffered})`);
    assert.equal(await next(ws), big, 'a 1 MiB message');
    assert.equal(ws.buffered, 0);
    ws.close(4000, 'é'.repeat(100));
    assert.equal(ws.send('late').code, 'EPIPE', 'send after close returns an EPIPE Error');
    assert.deepEqual(await ws.closed, { code: 4000, reason: 'é'.repeat(61) }, 'a client close, its reason cut to 123 bytes at a UTF-8 boundary');
    assert.deepEqual(await ws.messages.next(), { value: undefined, done: true });

    const plain = await ipn.websocket({ url: `${base}/echo` });
    assert.equal(plain.protocol, '', 'no subprotocol offered, none chosen');
    plain.send('one');
    plain.send('close-me');
    const got = [];
    for await (const m of plain.messages) got.push(m);
    assert.deepEqual(got, ['one'], 'messages is async iterable, and ends at the close');
    assert.deepEqual(await plain.closed, { code: 4001, reason: 'server bye' }, 'a server close');
    await wait(1500);
    assert.equal(plain.send('x').code, 'EPIPE', 'the stand-ins after release');
    plain.close();
    assert.equal(plain.buffered, 0);

    await assert.rejects(ipn.websocket({ url: `${base}/refuse` }), (error) => {
      assert.equal(error.status, 403);
      assert.match(error.message, /403/);
      return true;
    }, 'a refused handshake rejects with its status');
  }
  const base = `ws://${tailnet.peer.ip}:${wsPort}`;
  const late = await ipn.websocket({ url: `${base}/unread` });
  assert.equal((await late.closed).code, 4002);
  await wait(1000);
  assert.equal((await next(late)).length, 15 * MiB, 'a closed socket still gives what it received, read soon after');
  const unread = async () => {
    let ws;
    for (let n = 0; n < 8; n++) {
      ws = await ipn.websocket({ url: `${base}/unread` });
      await ws.closed;
    }
    await wait(6000);
    return ws;
  };
  await unread();
  const settled = memory();
  await unread();
  await unread();
  const last = await unread();
  const kept = (memory() - settled) / MiB;
  assert.ok(kept < 16, `closed sockets left unread are dropped (+${kept} MiB)`);
  assert.deepEqual(await last.messages.next(), { value: undefined, done: true }, 'a reaped socket says done');
  assert.equal(last.send('x').code, 'EPIPE', 'a reaped socket has its stand-ins');
  const slow = new AbortController();
  const pending = ipn.websocket({ url: `${base}/slow`, signal: slow.signal });
  setTimeout(() => slow.abort(), 500);
  await assert.rejects(pending, { name: 'AbortError' }, 'abort cancels the handshake');
  await assert.rejects(ipn.websocket({ url: `${base}/echo`, signal: AbortSignal.abort() }), { name: 'AbortError' });
  const live = new AbortController();
  const aborted = await ipn.websocket({ url: `${base}/echo`, signal: live.signal });
  live.abort();
  assert.deepEqual(await aborted.closed, { code: 1001, reason: 'the request was aborted' }, 'abort closes an open socket');
  // A peer that stops reading: sends stall, abort still closes, and buffered
  // drops to 0 and stays there, whether abort or the connection ends it.
  const stall = async (signal) => {
    const ws = await ipn.websocket({ url: `${base}/deaf`, signal });
    for (let n = 0; n < 8; n++) ws.send(new Uint8Array(8 * 1024 * 1024));
    await wait(2500);
    assert.ok(ws.buffered > 0, `a deaf peer leaves bytes unsent (${ws.buffered})`);
    return ws;
  };
  const stuck = new AbortController();
  const deaf = await stall(stuck.signal);
  stuck.abort();
  assert.equal(deaf.buffered, 0, 'abort drops what was queued');
  assert.equal((await deaf.closed).code, 1006, 'abort gets past a stalled write, tearing the connection down');
  await wait(500);
  assert.equal(deaf.buffered, 0);
  const dropped = await stall();
  assert.equal((await dropped.closed).code, 1006, 'the peer dropping the connection ends a stalled socket');
  await wait(500);
  assert.equal(dropped.buffered, 0, 'buffered stays 0 after the stalled write fails');
  const huge = await ipn.websocket({ url: `${base}/echo` });
  assert.equal(huge.send(new Uint8Array(64 * 1024 * 1024 + 1)).code, 'EMSGSIZE');
  assert.equal((await huge.closed).code, 1009, 'sending over 64 MiB closes with 1009');
  const flood = await ipn.websocket({ url: `${base}/echo` });
  flood.send('big');
  assert.equal((await flood.closed).code, 1009, 'receiving over 64 MiB closes with 1009');
  assert.deepEqual(await flood.messages.next(), { value: undefined, done: true });
  for (const [text, what] of [['x'.repeat(64 * MiB + 1), 'ASCII'], ['€'.repeat(22369622), 'UTF-8']]) {
    const ws = await ipn.websocket({ url: `${base}/echo` });
    const before = memory();
    assert.equal(ws.send(text).code, 'EMSGSIZE', `text over 64 MiB (${what})`);
    assert.equal((await ws.closed).code, 1009, `text over 64 MiB closes with 1009 (${what})`);
    const grown = (memory() - before) / MiB;
    assert.ok(grown < 16, `text over 64 MiB is refused before it reaches Go (${what}, +${grown} MiB)`);
  }
  await assert.rejects(ipn.websocket({ url: `ws://${tailnet.peer.ip}:1/` }), 'a closed port rejects');
  assert.deepEqual(
    browserSockets.filter((url) => url.includes(`:${wsPort}`)),
    [],
    'websocket() never uses the JS WebSocket'
  );

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
  console.error('ok: joined a local headscale tailnet, dialled a peer, half-closed, WebSockets by address and name, nothing inbound, exit node by name and ID');
  await done(0);
} catch (error) {
  console.error(error);
  await done(1);
}
