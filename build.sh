#!/bin/sh
# Builds package/dist from the pinned Tailscale tag plus patches/*.patch.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
tag=$(node -p "require('$here/upstream.json').tag")
commit=$(node -p "require('$here/upstream.json').commit")
repo=$(node -p "require('$here/upstream.json').repository")
version=$(node -p "require('$here/package/package.json').version")
src="${TAILSCALE_SRC:-$here/.build/tailscale}"

if [ ! -d "$src/.git" ]; then
  git clone --quiet --depth 1 --branch "$tag" "$repo" "$src"
fi
cd "$src"
git -c advice.detachedHead=false checkout --quiet "$commit"
test "$(git rev-parse HEAD)" = "$commit"
git reset --quiet --hard "$commit"
git -c user.name=build -c user.email=build@localhost am --quiet --committer-date-is-author-date "$here"/patches/*.patch

tags=$(./tool/go run ./cmd/tsconnect/wasmbuild/printtags)
short=${tag#v}
out="$here/package/dist"
mkdir -p "$out"
(
  cd cmd/tsconnect
  GOOS=js GOARCH=wasm ../../tool/go build -tags "$tags" -trimpath -buildvcs=false \
    -ldflags "-s -w -buildid= -X tailscale.com/version.shortStamp=$short -X tailscale.com/version.longStamp=$version" \
    -o "$out/main.wasm" ./wasm
)
cp "$(./tool/go env GOROOT)/lib/wasm/wasm_exec.js" "$out/wasm_exec.js"

node - "$out" "$tag" "$commit" "$version" "$(./tool/go env GOVERSION)" "$here/patches" <<'JS'
const { createHash } = require('node:crypto');
const { readFileSync, readdirSync, writeFileSync } = require('node:fs');
const [out, tag, commit, version, go, patches] = process.argv.slice(2);
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const info = {
  version,
  tailscale: { tag, commit },
  go,
  patches: readdirSync(patches).filter((f) => f.endsWith('.patch')).sort().map((f) => ({ file: f, sha256: sha(`${patches}/${f}`) })),
  files: { 'main.wasm': sha(`${out}/main.wasm`), 'wasm_exec.js': sha(`${out}/wasm_exec.js`) },
};
writeFileSync(`${out}/build-info.json`, `${JSON.stringify(info, null, 2)}\n`);
console.log(JSON.stringify(info, null, 2));
JS
