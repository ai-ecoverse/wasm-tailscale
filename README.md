# wasm-tailscale

[Tailscale](https://github.com/tailscale/tailscale)'s browser client, tsconnect (Go compiled to `js/wasm`), with the APIs [SLICC](https://github.com/ai-ecoverse/slicc-bios) needs to use a tailnet as a network transport. It's published as [`@ai-ecoverse/wasm-tailscale`](https://www.npmjs.com/package/@ai-ecoverse/wasm-tailscale).

This repo holds no Tailscale source. It pins a Tailscale tag in [`upstream.json`](upstream.json) and keeps SLICC's changes as a readable patch series in [`patches/`](patches/). [`build.sh`](build.sh) clones the tag, checks the commit, applies the patches and builds `package/dist/`.

## What the patches add

On top of upstream tsconnect's `run`, `login`, `logout`, `ssh` and `fetch(url)`:

- **`fetch(request)`:** a full HTTP request (method, headers, body) through the tailnet, with a streamed response (`read()` / `cancel()`). `manualRedirects` returns redirects unfollowed. With `encodedBodies` off, Go negotiates gzip and decodes the body. TLS is Go's own, verified against Mozilla's root certificates, which the build embeds because Go has no system roots under `js/wasm`. No CORS applies.
- **`dial(network, addr)`:** a raw TCP (or UDP) connection with `read()`, `write()` and `close()`. Each dial gives up after 30 s.
- **`setExitNode(expr)`:** `""` for none, `auto:any`, an IP, a MagicDNS name or a stable node ID.
- **`status()`:** the backend state, this node, its peers, the exit node, `shieldsUp` and `controlURL`, as JSON. It can be called from the `notify*` callbacks, which the patches deliver on their own JS task. Upstream calls them synchronously from inside Go, where calling back into Go deadlocks js/wasm's single thread. The `stateStorage` callbacks have to stay synchronous, because Go needs `getState`'s answer. Inside them, `status()` returns an `Error` instead of hanging. Defer it there with `setTimeout(…, 0)`. A callback that throws doesn't end the Go program:
  - a throwing `notify*` callback is reported through `notifyPanicRecover`, and the node keeps running;
  - a throwing `stateStorage` callback becomes a storage error inside Go. What follows depends on when it happens:
    - while `newIPN` builds the backend, `newIPN` returns an `Error` (`newIPN: <step>: …`) instead of a node;
    - during `run()`'s start, the node stays stopped in `NoState`, and `notifyPanicRecover` reports `Tailscale could not start: …`;
    - later, Tailscale handles it like any failed state write: the change isn't saved, and the node keeps running.
- **`login(authKey)`:** logs in with an auth key that arrives after start, for example one pasted by the user. The key is only an option of that one start; it's never stored. Both `login()` and `login(authKey)` are refused before `run()`, and wait for `run()`'s start to finish.
- **Configuration:** `newIPN` takes `exitNode`, `ephemeral` (default `true`, as upstream) and `logUpload` (default `false`, so nothing goes to `log.tailscale.com`). An empty `controlURL` means Tailscale's default control server.
- **Shields up, kept up:** tailnet peers can't open connections to the node. `run()`'s start sets shields up, the configured control server, the hostname and accepted routes. The same prefs are applied again before every login (with or without a key), after `logout()` (which replaces the profile with Tailscale's defaults: shields down, the default control server), and whenever a prefs change drops any of them. Logins wait until `run()`'s start has returned.
- **Subnet routes are accepted** (`RouteAll` is true, unlike upstream's tsconnect). Routes that other nodes advertise are used, and traffic to them goes to the advertising peer, not to the exit node.
- **Build features:** the build keeps `useexitnode`, `peerapiclient` (DNS through the exit node) and `useroutes`. Everything that serves peers (peerapi server, serve, ssh server, taildrop, drive) stays compiled out, as in upstream's wasm build.

## The package

- `dist/main.wasm`: about 30 MB, 4.7 MB with brotli.
- `dist/wasm_exec.js`: from the same Go toolchain.
- `dist/build-info.json`: the Tailscale tag and commit, the Go version, the sha256 of every patch and file.
- `THIRD-PARTY-NOTICES.md`: the licences of everything linked into `main.wasm` (see below).
- `index.d.ts`: the API above.

To load it, run `wasm_exec.js` (it defines `globalThis.Go`), instantiate `main.wasm` with `new Go().importObject`, call `go.run(instance)`, and wait for `globalThis.newIPN`. `newIPN` is a single global per JavaScript realm, so run it in its own worker.

**`stateStorage` holds secrets.** The module keeps `_machinekey`, `log-policy` and the profile state there. With `ephemeral: false`, that includes the node's private key, so whoever holds the storage can act as the node. Embedders must store it like a credential: not in `localStorage` on a shared origin, not in logs. The auth key is never written to `stateStorage`.

`THIRD-PARTY-NOTICES.md` lists every Go module linked into `main.wasm`, with its licence, copyright and NOTICE files, plus the Go standard library's licence. `build.sh` generates it from `go list -deps` with the build's tags.

Versions are `<tailscale version>-<n>`, for example `1.104.1-1`; `n` counts builds of the same tag.

## Build

```sh
./build.sh          # clones into .build/tailscale, or set TAILSCALE_SRC
node test/smoke.mjs # reaches Tailscale's control plane, checks shields up and the API
node test/empty-control-url.mjs # an empty controlURL settles on the default
node test/throwing-callbacks.mjs # throwing callbacks are survived and reported
node test/storage-failure.mjs newipn # broken storage: newIPN returns an Error
node test/storage-failure.mjs start  # broken storage during run(): reported, node stays stopped
node test/logout-check.mjs # interactive: join, logout, login again; prints sign-in links to /tmp/logout-check.out
```

The build uses Tailscale's pinned Go toolchain (`./tool/go`), `-trimpath`, `-buildvcs=false` and an empty build ID, so the same tag and patches give the same `main.wasm` on any machine. The packed tarball holds the same files everywhere. Its gzip bytes depend on Node's zlib, so CI pins Node `24.21.0`, and `publish` publishes the certified CI artifact itself rather than a repack.

## Updating

To move to a new Tailscale tag, rebase the patch series onto it. In a Tailscale clone, apply `patches/*.patch` to the old tag with `git am`, rebase onto the new tag, then refresh `patches/` with `git format-patch <new-tag>..HEAD`. Update `upstream.json`, and set `package/package.json`'s version to `<new version>-1`.

## CI

- **`build`:** runs on every push and pull request. It builds, runs the smoke test, and uploads the packed tarball as the `package` artifact, with `build-info.json`.
- **`publish`:** run by hand, with the id of a `build` run and the sha256 its certification gave. It publishes **that run's tarball, byte for byte**, with npm trusted publishing (OIDC) and provenance. Before it does, it rebuilds from the checked-out commit and runs [`scripts/assert-certified.mjs`](scripts/assert-certified.mjs), which refuses:
  - a tarball whose sha256 isn't the certified one;
  - a tarball whose files differ from the fresh build (compared by the uncompressed tar, because gzip's output differs between platforms while the files don't);
  - links, or entries outside `package/`;
  - a tarball without `THIRD-PARTY-NOTICES.md`, `LICENSE` or `dist/main.wasm`;
  - a different package name, or a version that isn't `X.Y.Z-N`.

  A version already on npm is skipped. `scripts/pack.sh` packs locally the way CI does and prints the sha256.

## License

BSD 3-Clause, as Tailscale's (see [LICENSE](LICENSE)). The patches are under the same license. `main.wasm` also contains code under Apache-2.0, MIT and BSD licences; see `THIRD-PARTY-NOTICES.md` in the package.
