import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HEADSCALE = process.env.HEADSCALE;
const TAILSCALED = process.env.TAILSCALED;
const TAILSCALE = process.env.TAILSCALE;

export const tailnetAvailable = [HEADSCALE, TAILSCALED, TAILSCALE].every(
  (bin) => bin && existsSync(bin)
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve) => {
    const server = createTcpServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function corsProxy(target, port) {
  const server = createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': req.headers.origin ?? '*',
      'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'cross-origin-resource-policy': 'cross-origin',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const upstream = request(
      { host: '127.0.0.1', port: target, path: req.url, method: req.method, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode, { ...answer.headers, ...cors });
        answer.pipe(res);
      }
    );
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    const upstream = connect(target, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function halfCloseServer(port) {
  const server = createTcpServer((socket) => {
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () =>
      socket.end(Buffer.concat([Buffer.from('got '), ...chunks, Buffer.from(' then EOF')]))
    );
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function webServer(port, body) {
  const server = createServer((req, res) => {
    if (req.url === '/headers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.headers));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function wsFrame(op, payload = Buffer.alloc(0), fin = true) {
  const n = payload.length;
  const head = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  head[0] = (fin ? 0x80 : 0) | op;
  if (n < 126) head[1] = n;
  else if (n < 65536) {
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

function wsClosePayload(code, reason) {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(code);
  return Buffer.concat([out, Buffer.from(reason)]);
}

// A WebSocket echo server, written out here so the test needs no package.
// GET /refuse answers 403, /slow takes 5 s to answer, and /deaf never reads
// what it's sent and drops the connection after 4 s. It picks the
// subprotocol chat.v2 when offered, and echoes every message, except for a
// few text commands: "headers" sends the handshake's headers as JSON,
// "close-me" closes with 4001 "server bye", "ping-me" pings and answers
// "pong received" once the pong comes back, "fragments" sends "fragmented"
// in three frames, and "big" sends a message one byte over 64 MiB. A close
// frame is answered with the same code and reason.
function wsServer(port) {
  const server = createServer((_req, res) => {
    res.writeHead(426);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => {});
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/refuse') {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const offered = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    const answer = () => {
      if (socket.destroyed) return;
      socket.write(
        [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          ...(offered.includes('chat.v2') ? ['Sec-WebSocket-Protocol: chat.v2'] : []),
          '',
          '',
        ].join('\r\n')
      );
      if (path === '/deaf') {
        socket.pause();
        setTimeout(() => socket.destroy(), 4000);
        return;
      }
      if (path === '/unread') {
        socket.write(wsFrame(2, Buffer.alloc(15 * 1024 * 1024, 7)));
        socket.write(wsFrame(8, wsClosePayload(4002, 'unread')));
        socket.on('data', () => socket.end());
        setTimeout(() => socket.destroy(), 10000);
        return;
      }
      wsServe(socket, req);
    };
    setTimeout(answer, path === '/slow' ? 5000 : 0);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function wsServe(socket, req) {
  let buffer = Buffer.alloc(0);
  let parts = [];
  let partOp = 0;
  let closing = false;
  let pinged = false;
  const send = (op, payload) => socket.write(wsFrame(op, payload));
  const message = (op, payload) => {
    const text = op === 1 ? payload.toString() : null;
    if (text === 'headers') send(1, Buffer.from(JSON.stringify(req.headers)));
    else if (text === 'close-me') {
      closing = true;
      send(8, wsClosePayload(4001, 'server bye'));
    } else if (text === 'ping-me') {
      pinged = true;
      send(9, Buffer.from('are you there'));
    } else if (text === 'fragments') {
      socket.write(wsFrame(1, Buffer.from('frag'), false));
      socket.write(wsFrame(0, Buffer.from('ment'), false));
      socket.write(wsFrame(0, Buffer.from('ed'), true));
    } else if (text === 'big') send(2, Buffer.alloc(64 * 1024 * 1024 + 1, 7));
    else send(op, payload);
  };
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0] & 0x80) !== 0;
      const op = buffer[0] & 0x0f;
      let n = buffer[1] & 0x7f;
      let at = 2;
      if (n === 126) {
        if (buffer.length < 4) return;
        n = buffer.readUInt16BE(2);
        at = 4;
      } else if (n === 127) {
        if (buffer.length < 10) return;
        n = Number(buffer.readBigUInt64BE(2));
        at = 10;
      }
      const masked = (buffer[1] & 0x80) !== 0;
      if (buffer.length < at + (masked ? 4 : 0) + n) return;
      const mask = masked ? buffer.subarray(at, at + 4) : null;
      at += masked ? 4 : 0;
      const payload = Buffer.from(buffer.subarray(at, at + n));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(at + n);
      if (op === 8) {
        if (!closing) send(8, payload);
        socket.end();
        return;
      }
      if (op === 9) send(10, payload);
      else if (op === 10) {
        if (pinged) send(1, Buffer.from('pong received'));
        pinged = false;
      } else {
        if (op !== 0) partOp = op;
        parts.push(payload);
        if (fin) {
          const whole = Buffer.concat(parts);
          parts = [];
          message(partOp, whole);
        }
      }
    }
  });
}

// A tailnet of its own: headscale with its embedded DERP on loopback (plain
// HTTP, so the browser speaks DERP over ws://), a CORS proxy in front of it
// for the browser's control requests, and two userspace tailscaled nodes on
// this machine: "peer" serves a web page and a half-close echo on its
// loopback, "exit" offers itself as an exit node. Needs no account, no
// sign-in and no key from anyone. "peer" also serves a WebSocket echo.
export async function startTailnet() {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-tailnet-'));
  const [hsPort, proxyPort, stunPort, metricsPort, grpcPort, webPort, echoPort, wsPort] = await Promise.all(
    Array.from({ length: 8 }, freePort)
  );
  const config = join(dir, 'config.yaml');
  await writeFile(
    config,
    `server_url: http://127.0.0.1:${hsPort}
listen_addr: 127.0.0.1:${hsPort}
metrics_listen_addr: 127.0.0.1:${metricsPort}
grpc_listen_addr: 127.0.0.1:${grpcPort}
noise:
  private_key_path: ${dir}/noise.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: true
    region_id: 999
    region_code: local
    region_name: Local DERP
    verify_clients: true
    stun_listen_addr: 127.0.0.1:${stunPort}
    private_key_path: ${dir}/derp.key
    automatically_add_embedded_derp_region: true
    ipv4: 127.0.0.1
  urls: []
  paths: []
  auto_update_enabled: false
disable_check_updates: true
database:
  type: sqlite
  sqlite:
    path: ${dir}/db.sqlite
log:
  level: warn
policy:
  mode: file
  path: ""
dns:
  magic_dns: true
  base_domain: slicc.test
  override_local_dns: false
  nameservers:
    global: []
unix_socket: ${dir}/headscale.sock
unix_socket_permission: "0770"
`
  );
  const children = [];
  const servers = [];
  const hs = (...args) =>
    run(HEADSCALE, ['-c', config, ...args]).then(({ stdout }) => stdout.trim());
  children.push(spawn(HEADSCALE, ['serve', '-c', config], { stdio: 'ignore' }));
  for (let i = 0; i < 100; i++) {
    if (
      await hs('users', 'list').then(
        () => true,
        () => false
      )
    )
      break;
    await wait(100);
  }
  await hs('users', 'create', 'slicc');
  const users = JSON.parse(await hs('users', 'list', '-o', 'json'));
  const user = String(users.find((u) => u.name === 'slicc').id);
  const key = (
    await hs(
      'preauthkeys',
      'create',
      '--user',
      user,
      '--reusable',
      '--ephemeral',
      '--expiration',
      '1h'
    )
  )
    .split('\n')
    .at(-1);
  servers.push(await corsProxy(hsPort, proxyPort));
  servers.push(await webServer(webPort, `hello from the local tailnet ${Date.now()}`));
  servers.push(await halfCloseServer(echoPort));
  servers.push(await wsServer(wsPort));

  const env = { ...process.env, TS_DEBUG_USE_DERP_HTTP: '1' };
  const node = async (name, extra = []) => {
    const state = join(dir, name);
    const socket = join(dir, `${name}.sock`);
    children.push(
      spawn(
        TAILSCALED,
        [
          '--tun=userspace-networking',
          '--state=mem:',
          `--socket=${socket}`,
          `--statedir=${state}`,
          '--port=0',
        ],
        {
          env,
          stdio: 'ignore',
        }
      )
    );
    const cli = (...args) =>
      run(TAILSCALE, [`--socket=${socket}`, ...args], { env }).then(({ stdout }) => stdout.trim());
    for (let i = 0; i < 100; i++) {
      if (
        await cli('version').then(
          () => true,
          () => false
        )
      )
        break;
      await wait(100);
    }
    await cli(
      'up',
      `--login-server=http://127.0.0.1:${hsPort}`,
      `--auth-key=${key}`,
      `--hostname=${name}`,
      '--timeout=60s',
      ...extra
    );
    const ip = await cli('ip', '-4');
    return { name, ip, socket, cli: `${TAILSCALE} --socket=${socket}` };
  };
  const peer = await node('peer');
  const exit = await node('exit', ['--advertise-exit-node']);
  const nodes = JSON.parse(await hs('nodes', 'list', '-o', 'json'));
  const exitId = String(nodes.find((n) => n.given_name === 'exit' || n.name === 'exit').id);
  await hs('nodes', 'approve-routes', '--identifier', exitId, '--routes', '0.0.0.0/0,::/0');

  return {
    controlURL: `http://127.0.0.1:${proxyPort}`,
    key,
    peer: { ...peer, web: `http://${peer.ip}:${webPort}/`, echo: `${peer.ip}:${echoPort}`, wsPort },
    exit,
    async close() {
      for (const server of servers) server.close();
      for (const child of children.reverse()) child.kill();
      await wait(300);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
