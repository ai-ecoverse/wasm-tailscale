import { execFile, spawn } from 'node:child_process';
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
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// A tailnet of its own: headscale with its embedded DERP on loopback (plain
// HTTP, so the browser speaks DERP over ws://), a CORS proxy in front of it
// for the browser's control requests, and two userspace tailscaled nodes on
// this machine: "peer" serves a web page and a half-close echo on its
// loopback, "exit" offers itself as an exit node. Needs no account, no
// sign-in and no key from anyone.
export async function startTailnet() {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-tailnet-'));
  const [hsPort, proxyPort, stunPort, metricsPort, grpcPort, webPort, echoPort] = await Promise.all(
    Array.from({ length: 7 }, freePort)
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
    peer: { ...peer, web: `http://${peer.ip}:${webPort}/`, echo: `${peer.ip}:${echoPort}` },
    exit,
    async close() {
      for (const server of servers) server.close();
      for (const child of children.reverse()) child.kill();
      await wait(300);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
