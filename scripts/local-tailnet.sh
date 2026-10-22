#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${HEADSCALE:-}" ] || [ -z "${TAILSCALED:-}" ] || [ -z "${TAILSCALE:-}" ]; then
  if [ "$(uname -sm)" != "Linux x86_64" ]; then
    echo "local-tailnet: set HEADSCALE, TAILSCALED and TAILSCALE, or run on Linux x86_64" >&2
    exit 1
  fi
  dir=$(mktemp -d)
  trap 'rm -rf "$dir"' EXIT
  trap 'exit 1' INT TERM HUP
  curl -fsSL --retry 3 --max-time 300 -o "$dir/headscale" https://github.com/juanfont/headscale/releases/download/v0.29.4/headscale_0.29.4_linux_amd64
  curl -fsSL --retry 3 --max-time 300 -o "$dir/tailscale.tgz" https://pkgs.tailscale.com/stable/tailscale_1.104.1_amd64.tgz
  (cd "$dir" && sha256sum -c -) <<'SUMS'
212ed0a884c0d3541e094c4bebbe94397df6f4e01bd3d7f059c520cb55e0d757  headscale
108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528  tailscale.tgz
SUMS
  chmod +x "$dir/headscale"
  tar -xzf "$dir/tailscale.tgz" -C "$dir" --strip-components=1
  HEADSCALE=$dir/headscale TAILSCALED=$dir/tailscaled TAILSCALE=$dir/tailscale
  export HEADSCALE TAILSCALED TAILSCALE
fi
node "$here/test/local-tailnet.mjs"
