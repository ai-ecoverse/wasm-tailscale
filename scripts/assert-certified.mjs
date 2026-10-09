#!/usr/bin/env node
// Gate for publish.yml: the tarball must be the certified one, and, with
// --rebuilt, hold exactly the files of a fresh build (gzip output differs by
// platform, so the rebuilt tarball is compared by its uncompressed tar).
//   node scripts/assert-certified.mjs <tgz> --certified <sha256> [--rebuilt <tgz>]
// Exit 0: certified, publish. Exit 10: already on npm, skip. Exit 2: refuse.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const NAME = '@ai-ecoverse/wasm-tailscale';
const refuse = (message) => {
  console.error(`refuse: ${message}`);
  process.exit(2);
};
const tgz = process.argv[2];
const flag = (name) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? (process.argv[at + 1] ?? '') : '';
};
const certified = flag('--certified').trim().toLowerCase();
const rebuilt = flag('--rebuilt');
if (!tgz || tgz.startsWith('-')) refuse('usage: assert-certified.mjs <tgz> --certified <sha256>');
if (!/^[0-9a-f]{64}$/.test(certified)) refuse('certified must be the 64-character sha256 of the certified tarball');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bytes = readFileSync(tgz);
const sha256 = hash(bytes);
const content = hash(gunzipSync(bytes));
console.log(`tarball sha256 ${sha256}, tar sha256 ${content}`);
if (rebuilt) {
  const fresh = hash(gunzipSync(readFileSync(rebuilt)));
  if (fresh !== content) refuse(`a fresh build packs tar sha256 ${fresh}, not ${content}`);
  console.log('a fresh build from this commit packs the same files');
}

const listing = execFileSync('tar', ['-tvzf', tgz], { encoding: 'utf8' }).split('\n').filter(Boolean);
const links = listing.filter((line) => /^[lh]/.test(line) || / link to | -> /.test(line));
if (links.length) refuse(`the tarball contains links:\n${links.join('\n')}`);
const outside = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((path) => !path.startsWith('package/') || path.split('/').includes('..'));
if (outside.length) refuse(`entries outside package/:\n${outside.join('\n')}`);

const entries = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n');
for (const required of ['package/THIRD-PARTY-NOTICES.md', 'package/LICENSE', 'package/dist/main.wasm'])
  if (!entries.includes(required)) refuse(`the tarball has no ${required}`);

const { name, version } = JSON.parse(execFileSync('tar', ['-xOzf', tgz, 'package/package.json'], { encoding: 'utf8' }));
if (name !== NAME) refuse(`tarball is ${name}, not ${NAME}`);
if (!/^\d+\.\d+\.\d+-\d+$/.test(version)) refuse(`version ${version} is not X.Y.Z-N`);

const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(NAME)}/${version}`);
if (response.status === 200) {
  console.log(`${NAME}@${version} is already on npm; nothing to publish`);
  process.exit(10);
}
if (response.status !== 404) refuse(`npm registry answered ${response.status} for ${version}`);
if (sha256 !== certified) refuse(`tarball sha256 ${sha256} is not the certified ${certified}`);
console.log(`certified: publishing ${NAME}@${version}`);
