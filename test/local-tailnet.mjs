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
  const slowReader = await ipn.websocket({ url: `${base}/unread` });
  assert.equal((await slowReader.closed).code, 4002);
  await wait(10000);
  assert.equal((await next(slowReader)).length, 15 * MiB, 'a reader busy for 10 s after the close still gets every message');
  assert.deepEqual(await slowReader.messages.next(), { value: undefined, done: true });
  const exits = async () => {
    let ws;
    for (let n = 0; n < 8; n++) {
      const owner = new AbortController();
      ws = await ipn.websocket({ url: `${base}/unread`, signal: owner.signal });
      await ws.closed;
      owner.abort();
      await assert.rejects(ws.messages.next(), { name: 'AbortError' }, 'unread messages of an exited owner reject next()');
    }
    return ws;
  };
  await exits();
  const settled = memory();
  await exits();
  await exits();
  const last = await exits();
  const kept = (memory() - settled) / MiB;
  assert.ok(kept < 96, `an exited owner's unread messages are released at once (+${kept} MiB)`);
  assert.equal(last.send('x').code, 'EPIPE', 'a released socket has its stand-ins');
  const over = await ipn.websocket({ url: `${base}/unread-over` });
  await wait(10000);
  over.close();
  await over.closed;
  await assert.rejects(over.messages.next(), (error) => {
    assert.equal(error.code, 'EDROPPED');
    assert.equal(error.dropped, 2);
    assert.match(error.message, /2 unread WebSocket messages dropped: the WebSocket closed holding over 16 MiB/);
    return true;
  }, 'messages over the cap held by a closed socket reject next(), never a silent done');
  const stats = tailnet.stats;
  const tlsPort = tailnet.peer.tlsPort;
  for (const url of [`wss://${tailnet.peer.ip}:${tlsPort}/`, `wss://${peerDNS}:${tlsPort}/`, `https://${peerDNS}:${tlsPort}/`])
    await assert.rejects(ipn.websocket({ url }), /x509/, `an untrusted certificate is refused (${url})`);
  await wait(200);
  assert.equal(stats.tls.secure, 0, 'no TLS session is established');
  assert.equal(stats.tls.requests, 0, 'no HTTP request is sent over an untrusted TLS connection');
  assert.equal(stats.tls.alerts.length, 3, 'each refusal reaches the server as a TLS alert');
  for (const alert of stats.tls.alerts) assert.match(alert, /bad.certificate/i);
  assert.deepEqual(stats.tls.sni, [peerDNS, peerDNS], 'the SNI is the MagicDNS name');

  const cased = await ipn.websocket({
    url: `${base}/echo`,
    headers: [
      ['COOKIE', 'a=1'],
      ['CoOkIe', 'b=2'],
      ['HOST', 'elsewhere.example'],
      ['SEC-WEBSOCKET-PROTOCOL', 'chat.v2'],
      ['Sec-WebSocket-Extensions', 'permessage-deflate'],
      ['Keep-Alive', 'timeout=5'],
      ['TE', 'trailers'],
      ['Trailer', 'X-Late'],
      ['Transfer-Encoding', 'chunked'],
      ['Content-Length', '5'],
      ['X-Mixed-Case', 'kept'],
    ],
  });
  cased.send('raw-headers');
  const raw = JSON.parse(await next(cased));
  const rawNames = raw.filter((_, n) => n % 2 === 0).map((name) => name.toLowerCase());
  const rawValue = (name) => raw[rawNames.indexOf(name) * 2 + 1];
  for (const name of ['cookie', 'sec-websocket-protocol', 'sec-websocket-extensions', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'content-length'])
    assert.ok(!rawNames.includes(name), `${name} in any case is dropped`);
  assert.equal(rawNames.filter((name) => name === 'host').length, 1, 'one Host');
  assert.equal(rawValue('host'), `${tailnet.peer.ip}:${wsPort}`, 'Host is the URL’s');
  assert.equal(rawValue('sec-websocket-version'), '13');
  assert.equal(rawValue('x-mixed-case'), 'kept');
  cased.close();
  await cased.closed;

  const connections = () => stats.ws.connections + stats.sink.connections;
  const quiet = async (what, attempt) => {
    const before = connections();
    await assert.rejects(attempt(), what);
    await wait(100);
    assert.equal(connections(), before, `${what}: nothing reaches a server`);
  };
  for (const [name, value] of [
    ['x-bad\r\nx-injected', 'v'],
    ['x-ok', 'a\r\nx-injected: 1'],
    ['x-ok', 'a\nb'],
    ['x-ok', 'a\0b'],
    ['x-bad\0', 'v'],
  ])
    await quiet(`CR, LF or NUL in ${JSON.stringify([name, value])}`, () => ipn.websocket({ url: `${base}/echo`, headers: [[name, value]] }));
  for (const url of [
    `ftp://${tailnet.peer.ip}:${wsPort}/`,
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/plain,x',
    `blob:http://${tailnet.peer.ip}:${wsPort}/x`,
    `gopher://${tailnet.peer.ip}:${wsPort}/`,
    '/echo',
    'ws:///echo',
  ])
    await quiet(`the URL ${url}`, () => ipn.websocket({ url }));
  const sinkBefore = stats.sink.connections;
  await assert.rejects(
    ipn.websocket({ url: `${base}/redirect`, headers: [['authorization', 'Bearer secret']] }),
    (error) => error.status === 302,
    'a redirect rejects with its status'
  );
  await wait(200);
  assert.equal(stats.sink.connections, sinkBefore, 'a redirect is not followed');
  const loopback = async (when) => {
    for (const host of ['127.0.0.1', 'localhost'])
      await quiet(`ws://${host} ${when}`, () => ipn.websocket({ url: `ws://${host}:${tailnet.peer.sinkPort}/` }));
  };
  await loopback('without an exit node');

  const slow = new AbortController();
  const pending = ipn.websocket({ url: `${base}/slow`, signal: slow.signal });
  let abortedAt = 0;
  setTimeout(() => {
    abortedAt = Date.now();
    slow.abort();
  }, 500);
  await assert.rejects(pending, { name: 'AbortError' }, 'abort cancels the handshake');
  for (let waited = 0; waited < 2000 && !tailnet.stats.ws.slowClosed; waited += 50) await wait(50);
  assert.ok(
    tailnet.stats.ws.slowClosed && tailnet.stats.ws.slowClosed - abortedAt < 1000,
    'abort tears the handshake’s connection down within 1 s'
  );
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
  await loopback('with an exit node');
  console.error('ok: joined a local headscale tailnet, dialled a peer, half-closed, WebSockets by address and name, nothing inbound, exit node by name and ID');
  await done(0);
} catch (error) {
  console.error(error);
  await done(1);
}
