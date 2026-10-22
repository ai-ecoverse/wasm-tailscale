import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, NAME, nextVersion } from '../scripts/release.mjs';

const answers = new Map();
const server = createServer((req, res) => {
  const [status, body] = answers.get(req.url) ?? [404, {}];
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const registry = `http://127.0.0.1:${server.address().port}/`;
const path = `/${NAME.replace('/', '%2f')}`;
const versions = (...list) => ({ versions: Object.fromEntries(list.map((v) => [v, {}])) });

try {
  answers.set(path, [200, versions('0.0.0-stage', '1.104.1-3', '1.104.1-12', '1.104.1-9', '1.104.10-40', '1.104.1')]);
  assert.equal(await nextVersion({ registry, tag: 'v1.104.1' }), '1.104.1-13', 'one past the highest build of the tag');
  assert.equal(await nextVersion({ registry, tag: 'v1.106.0' }), '1.106.0-1', 'a new tag starts at 1');
  answers.set(path, [404, {}]);
  assert.equal(await nextVersion({ registry, tag: 'v1.104.1' }), '1.104.1-1', 'an unpublished package starts at 1');
  answers.set(path, [503, {}]);
  await assert.rejects(nextVersion({ registry, tag: 'v1.104.1' }), /answered 503/, 'a registry error is no version');
} finally {
  server.close();
}

const work = mkdtempSync(join(tmpdir(), 'wasm-tailscale-release-test-'));
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const tailscale = { tag: 'v1.104.1', commit: 'c0ffee' };
const pack = (name, { version = '1.104.1-13', info = {}, extra } = {}) => {
  const pkg = join(work, name);
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  const write = (file, body) => writeFileSync(join(pkg, file), body);
  write('package.json', `${JSON.stringify({ name: NAME, version, files: ['README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'index.d.ts', 'dist'] }, null, 2)}\n`);
  for (const file of ['README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'index.d.ts', 'dist/wasm_exec.js']) write(file, `${file}\n`);
  write('dist/main.wasm', Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  extra?.(pkg);
  const files = Object.fromEntries(
    [['main.wasm', 'dist/main.wasm'], ['wasm_exec.js', 'dist/wasm_exec.js'], ['THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md']].map(([k, f]) => [k, sha(join(pkg, f))]),
  );
  write('dist/build-info.json', `${JSON.stringify({ version, tailscale, files, ...info }, null, 2)}\n`);
  const [{ filename }] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: pkg, encoding: 'utf8' }));
  return { pkg, tgz: join(work, filename) };
};

try {
  const good = pack('good');
  check({ ...good, version: '1.104.1-13', tailscale });
  assert.throws(() => check({ ...good, version: '1.104.1-14', tailscale }), /version 1\.104\.1-13, not 1\.104\.1-14/);
  assert.throws(() => check({ ...good, version: '1.104.1-13', tailscale: { ...tailscale, commit: 'beef' } }), /built from/);
  writeFileSync(join(good.pkg, 'dist/main.wasm'), 'another build');
  assert.throws(() => check({ ...good, version: '1.104.1-13', tailscale }), /dist\/main\.wasm is not the one this build wrote/);
  const forged = pack('forged', { info: { files: { 'main.wasm': '0'.repeat(64) } } });
  assert.throws(() => check({ ...forged, version: '1.104.1-13', tailscale }), /build-info\.json says 0{64}/);
  const stale = pack('stale', { info: { version: '1.104.1-12' } });
  assert.throws(() => check({ ...stale, version: '1.104.1-13', tailscale }), /build-info\.json says 1\.104\.1-12/);
  const bare = pack('bare', { extra: (pkg) => rmSync(join(pkg, 'LICENSE')) });
  assert.throws(() => check({ ...bare, version: '1.104.1-13', tailscale }), /no LICENSE/);
  console.log('release: PASS the next build number and the tarball check');
} finally {
  rmSync(work, { recursive: true, force: true });
}
