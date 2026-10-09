#!/usr/bin/env node
// Writes THIRD-PARTY-NOTICES.md for main.wasm: every module linked into the
// build (from `go list -deps` with the build's tags), with each licence,
// copyright and NOTICE file found from a linked package's directory up to its
// module root, plus the Go toolchain's own LICENSE for the standard library
// and runtime.
//   node scripts/notices.mjs <tailscale source> <tags> <out file>
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const [given, tags, out] = process.argv.slice(2);
const src = resolve(given);
const go = join(src, 'tool', 'go');
const env = { ...process.env, GOOS: 'js', GOARCH: 'wasm' };
const listed = execFileSync(
  go,
  ['list', '-deps', '-tags', tags, '-f', '{{with .Module}}{{.Path}}\t{{.Version}}\t{{.Dir}}\t{{end}}{{.Dir}}', './cmd/tsconnect/wasm'],
  { cwd: src, env, encoding: 'utf8', maxBuffer: 1 << 26 }
);
const goroot = execFileSync(go, ['env', 'GOROOT'], { cwd: src, env, encoding: 'utf8' }).trim();
const goversion = execFileSync(go, ['env', 'GOVERSION'], { cwd: src, env, encoding: 'utf8' }).trim();

const NOTICE = /^(LICEN[CS]E|COPYING|NOTICE|PATENTS|AUTHORS|COPYRIGHT)(-[a-z0-9]+)?(\.(txt|md|rst))?$/i;
const modules = new Map();
for (const line of listed.split('\n').filter(Boolean)) {
  const parts = line.split('\t');
  if (parts.length < 4) continue;
  const [path, version, root, pkgDir] = parts;
  const module = modules.get(path) ?? { path, version: version || '(main module)', root, files: new Set() };
  modules.set(path, module);
  for (let dir = pkgDir; ; dir = dirname(dir)) {
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) if (NOTICE.test(name)) module.files.add(join(dir, name));
    }
    if (dir === root || !dir.startsWith(root + sep) && dir !== root) break;
  }
}

const LICENCE = /^(LICEN[CS]E|COPYING)(-[a-z0-9]+)?(\.(txt|md|rst))?$/i;
const sorted = [...modules.values()].sort((a, b) => a.path.localeCompare(b.path));
const missing = sorted
  .filter((m) => ![...m.files].some((file) => LICENCE.test(file.split(sep).pop())))
  .map((m) => m.path);
if (missing.length) {
  console.error(`no LICENSE, LICENCE or COPYING file for: ${missing.join(', ')}`);
  process.exit(1);
}
if (!existsSync(join(goroot, 'LICENSE'))) {
  console.error(`no LICENSE in the Go toolchain at ${goroot}`);
  process.exit(1);
}
const fence = (text) => {
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}text\n${text.trimEnd()}\n${ticks}`;
};
const toolchain = ['LICENSE', 'PATENTS']
  .filter((name) => existsSync(join(goroot, name)))
  .map((name) => `### ${name}\n\n${fence(readFileSync(join(goroot, name), 'utf8'))}`);
const sections = [
  `## Go standard library and runtime (${goversion})\n\n${toolchain.join('\n\n')}`,
  ...sorted.map((m) => {
    const files = [...m.files].sort().map((file) => {
      const name = relative(m.root, file).split(sep).join('/');
      return `### ${name}\n\n${fence(readFileSync(file, 'utf8'))}`;
    });
    return `## ${m.path} ${m.version}\n\n${files.join('\n\n')}`;
  }),
];
writeFileSync(
  out,
  `# Third-party notices\n\n\`main.wasm\` statically links the Go standard library and runtime and the ${sorted.length} Go modules below (from \`go list -deps\` of \`./cmd/tsconnect/wasm\` for \`js/wasm\` with this build's tags). Each section holds the licence, copyright and NOTICE files of that module, found from every linked package's directory up to the module root.\n\n${sections.join('\n\n')}\n`
);
console.log(`${out}: ${sorted.length} modules`);
