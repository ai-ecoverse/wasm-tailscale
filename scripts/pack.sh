#!/bin/sh
# Packs package/ the way CI does and prints the tarball's sha256.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
cp "$here/README.md" "$here/LICENSE" "$here/package/"
out="${1:-$here}"
mkdir -p "$out"
(cd "$here/package" && npm pack --silent --pack-destination "$out" >/dev/null)
tgz=$(ls "$out"/ai-ecoverse-wasm-tailscale-*.tgz)
shasum -a 256 "$tgz"
