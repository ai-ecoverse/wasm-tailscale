import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME = '@ai-ecoverse/wasm-tailscale';
const root = fileURLToPath(new URL('..', import.meta.url));
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...options });
const upstream = () => json(join(root, 'upstream.json'));

export async function nextVersion({ registry = 'https://registry.npmjs.org/', tag = upstream().tag } = {}) {
  const base = tag.replace(/^v/, '');
  const url = new URL(NAME.replace('/', '%2f'), registry.endsWith('/') ? registry : `${registry}/`);
  const response = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
  if (response.status !== 404 && !response.ok) throw new Error(`${url} answered ${response.status}`);
  const versions = response.status === 404 ? [] : Object.keys((await response.json()).versions ?? {});
  const builds = versions.map((v) => /^(.+)-(\d+)$/.exec(v)).filter((m) => m?.[1] === base).map((m) => Number(m[2]));
  return `${base}-${Math.max(0, ...builds) + 1}`;
}

export function check({ tgz, version, pkg = join(root, 'package'), tailscale = upstream() }) {
  const refuse = (why) => {
    throw new Error(`refusing ${tgz}: ${why}`);
  };
  const listing = run('tar', ['-tvzf', tgz]).split('\n').filter(Boolean);
  const links = listing.filter((line) => /^[lh]/.test(line));
  if (links.length) refuse(`links:\n${links.join('\n')}`);
  const entries = run('tar', ['-tzf', tgz]).split('\n').filter(Boolean);
  const outside = entries.filter((path) => !path.startsWith('package/') || path.split('/').includes('..'));
  if (outside.length) refuse(`entries outside package/:\n${outside.join('\n')}`);
  const files = ['package.json', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'index.d.ts', 'dist/build-info.json'];
  for (const file of [...files, 'dist/main.wasm', 'dist/wasm_exec.js'])
    if (!entries.includes(`package/${file}`)) refuse(`no ${file}`);
  const out = mkdtempSync(join(tmpdir(), 'wasm-tailscale-check-'));
  try {
    run('tar', ['-xzf', tgz, '-C', out]);
    compare(join(out, 'package'), { version, pkg, tailscale, refuse });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function compare(packed, { version, pkg, tailscale, refuse }) {
  const manifest = json(join(packed, 'package.json'));
  if (manifest.name !== NAME) refuse(`it is ${manifest.name}, not ${NAME}`);
  if (manifest.version !== version) refuse(`it is version ${manifest.version}, not ${version}`);
  const info = json(join(packed, 'dist/build-info.json'));
  if (info.version !== version) refuse(`build-info.json says ${info.version}, not ${version}`);
  if (info.tailscale.tag !== tailscale.tag || info.tailscale.commit !== tailscale.commit)
    refuse(`built from ${info.tailscale.tag} ${info.tailscale.commit}, not ${tailscale.tag} ${tailscale.commit}`);
  const paths = { 'main.wasm': 'dist/main.wasm', 'wasm_exec.js': 'dist/wasm_exec.js', 'THIRD-PARTY-NOTICES.md': 'THIRD-PARTY-NOTICES.md' };
  for (const [name, path] of Object.entries(paths)) {
    const hash = sha(join(packed, path));
    if (hash !== info.files[name]) refuse(`${path} is ${hash}, build-info.json says ${info.files[name]}`);
    if (hash !== sha(join(pkg, path))) refuse(`${path} is not the one this build wrote to ${pkg}`);
  }
  for (const file of ['package.json', 'README.md', 'LICENSE', 'index.d.ts', 'dist/build-info.json'])
    if (sha(join(packed, file)) !== sha(join(pkg, file))) refuse(`${file} is not the one in ${pkg}`);
}

let version;
let tarball;

export async function verifyRelease(_, { logger }) {
  version = await nextVersion();
  logger.log(`${NAME}@${version} is the next build of ${upstream().tag}`);
}

export function generateNotes() {
  return `npm: [\`${NAME}@${version}\`](https://www.npmjs.com/package/${NAME}/v/${version})`;
}

export function prepare(_, { logger }) {
  const pkg = join(root, 'package');
  const manifest = json(join(pkg, 'package.json'));
  writeFileSync(join(pkg, 'package.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  run(join(root, 'build.sh'), [], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
  for (const file of ['README.md', 'LICENSE']) copyFileSync(join(root, file), join(pkg, file));
  const out = mkdtempSync(join(tmpdir(), 'wasm-tailscale-pack-'));
  const [{ filename }] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', out], { cwd: pkg }));
  tarball = join(out, filename);
  check({ tgz: tarball, version });
  logger.log(`${tarball} holds this build, sha256 ${sha(tarball)}`);
}

export function publish(_, { logger }) {
  run('npm', ['publish', tarball, '--access', 'public', '--provenance', '--tag', 'latest'], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  logger.log(`published ${NAME}@${version}`);
  return { name: 'npm', url: `https://www.npmjs.com/package/${NAME}/v/${version}`, version, channel: 'latest' };
}
