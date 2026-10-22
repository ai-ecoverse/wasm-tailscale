# wasm-tailscale

[Tailscale](https://github.com/tailscale/tailscale)'s browser client, tsconnect (Go compiled to `js/wasm`), with the APIs [SLICC](https://github.com/ai-ecoverse/slicc-bios) needs to use a tailnet as a network transport. It's published as [`@ai-ecoverse/wasm-tailscale`](https://www.npmjs.com/package/@ai-ecoverse/wasm-tailscale).

This repo holds no Tailscale source. It pins a Tailscale tag in [`upstream.json`](upstream.json) and keeps SLICC's changes as a readable patch series in [`patches/`](patches/). [`build.sh`](build.sh) clones the tag, checks the commit, applies the patches and builds `package/dist/`.

## What the patches add

On top of upstream tsconnect's `run`, `login`, `logout`, `ssh` and `fetch(url)`:

- **`fetch(request)`:** a full HTTP request (method, headers, body) through the tailnet, with a streamed response (`read()` / `cancel()`). The hop-by-hop headers listed under `websocket` below, and Content-Length, are dropped from the request; Host sets the request's host. `manualRedirects` returns redirects unfollowed. With `encodedBodies` off, Go negotiates gzip and decodes the body. TLS is Go's own, verified against Mozilla's root certificates, which the build embeds because Go has no system roots under `js/wasm`. No CORS applies.
- **`dial(network, addr)`:** a raw TCP (or UDP) connection with `read()`, `write()`, `closeWrite()` (`shutdown(SHUT_WR)`) and `close()`. Don't use a connection after `close()`: its functions are released about a second later, and calling one then throws "call to released function". Each dial gives up after 30 s.
- **`websocket({ url, protocols, headers, signal })`:** a WebSocket over the tailnet, on the same dialer as `fetch` and `dial`: a public host goes through the exit node, a tailnet name or address to the peer. It's Go's WebSocket ([coder/websocket](https://github.com/coder/websocket)'s Go implementation, which upstream builds only outside `js/wasm`, so patch 0015 copies it into `tempfork/coder/websocket`), never the browser's: the handshake goes through the netstack, so no browser cookies, `Origin` or CORS ever apply. `wss:` is verified against the bundled roots, as `fetch` is. It resolves to an object in the shape of the kernel's `RealmWebSocket`:
  - `protocol`: the subprotocol the server chose, or `""`; `buffered`: the bytes given to `send` and not yet written;
  - `send(string | Uint8Array | ArrayBuffer)`: queues a text or binary message. It returns an `Error` instead of throwing: `code: 'EPIPE'` once the socket is closing, `code: 'EMSGSIZE'` for a message over 64 MiB, which also closes the socket with 1009. A string is measured before it's copied into Go, so an oversized one costs Go no memory;
  - `messages`: an async iterable (`for await`), or call `messages.next()` for `{ value, done }`. Each value is a whole message (fragments reassembled): a string for text, a `Uint8Array` for binary. `return()` drops what's left. A received message over 64 MiB closes the socket with 1009. Pings are answered in Go and never surfaced. Up to 16 MiB of messages wait for `next()`; beyond that Go stops reading, and the peer feels TCP's back pressure;
  - `close(code, reason)`: sends a close frame after what `send` queued. A code a client can't send becomes 1000; the reason is cut to 123 bytes at a UTF-8 boundary. As in a browser's CLOSING state, messages the peer sends before its own close frame still arrive in `messages`; the peer has 5 s to send that frame, or the connection is torn down;
  - `closed`: a promise of `{ code, reason }`, from the peer's close frame, whether it started the close or answered ours, 1005 for a frame without a code, 1006 for a connection that ended without one.

  `headers` (`[name, value][]`) go into the handshake, except Host, `Sec-WebSocket-*`, Cookie, Content-Length and the hop-by-hop headers: Connection and the headers it names, Keep-Alive, Proxy-Authorization, Proxy-Authenticate, Proxy-Connection, TE, Trailer, Transfer-Encoding and Upgrade (the handshake sets its own Connection and Upgrade). A refused handshake rejects with an `Error` whose `status` is the HTTP status (403 and so on); redirects aren't followed, as in a browser. `signal` (an `AbortSignal`) cancels the handshake, which rejects with `signal.reason`, and closes an open socket with 1001: what `send` queued is dropped, and a write in progress is cancelled, which tears the connection down (then `closed` gives 1006), since a peer that stops reading could otherwise hold the close back forever. Once `closed` has settled and `messages` has ended, the object's functions become plain JS stand-ins and Go's are released a second later, so don't keep references to them past that. A closed socket keeps its unread messages for a reader that's still busy, with three exceptions, in which it drops them and is released the same way: its `signal` was aborted (the owner is gone), it held over 16 MiB when it closed, or `messages` got no `next()` for 5 minutes after the close. Dropped messages are never a silent end: `next()` then rejects, with `signal.reason` after an abort, and otherwise with an `Error` whose `code` is `'EDROPPED'` and whose `dropped` is the number of messages lost. `messages.return()` drops them on purpose and says done.
- **`setExitNode(expr)`:** `""` for none, `auto:any`, an IP, a MagicDNS name or a stable node ID. A name or ID is selected by the node's address, because an `ExitNodeID` set through `EditPrefs` came back empty on headscale.
- **`status()`:** the backend state, this node, its peers, the exit node, `shieldsUp` and `controlURL`, as JSON. It can be called from the `notify*` callbacks, which the patches deliver on their own JS task. Upstream calls them synchronously from inside Go, where calling back into Go deadlocks js/wasm's single thread. The `stateStorage` callbacks have to stay synchronous, because Go needs `getState`'s answer. Inside them, `status()` returns an `Error` instead of hanging. Defer it there with `setTimeout(…, 0)`. A callback that throws doesn't end the Go program:
  - a throwing `notify*` callback is reported through `notifyPanicRecover`, and the node keeps running;
  - a throwing `stateStorage` callback becomes a storage error inside Go. What follows depends on when it happens:
    - while `newIPN` builds the backend, `newIPN` returns an `Error` (`newIPN: <step>: …`) instead of a node;
    - during `run()`'s start, the node stays stopped in `NoState`, and `notifyPanicRecover` reports `Tailscale could not start: …`. A later `login()` or `login(key)` runs the start again: once storage works, it reaches `NeedsLogin`; if it still fails, it reports the failure again;
    - later, Tailscale handles it like any failed state write: the change isn't saved, and the node keeps running.
- **`login(authKey)`:** logs in with an auth key that arrives after start, for example one pasted by the user. The key is only an option of that one start; it's never stored. Both `login()` and `login(authKey)` are refused before `run()`, and wait for `run()`'s start to finish. Logins and `logout()` run one at a time, so a burst of them (as when a page logs in on every `NeedsLogin` while the user pastes a key) can't meet the backend between two control clients.
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

Versions are `<tailscale version>-<n>`, for example `1.104.1-1`; `n` counts releases of the same tag.

## Build

```sh
./build.sh          # clones into .build/tailscale, or set TAILSCALE_SRC
npm test            # builds, then runs every test below but logout-check
node test/release.mjs # the next build number and the release's tarball check
node test/smoke.mjs # reaches Tailscale's control plane, checks shields up and the API
node test/empty-control-url.mjs # an empty controlURL settles on the default
node test/throwing-callbacks.mjs # throwing callbacks are survived and reported
node test/storage-failure.mjs newipn # broken storage: newIPN returns an Error
node test/storage-failure.mjs start  # broken storage during run(): reported, login() retries, works once storage recovers
node test/login-bursts.mjs healthy  # l,k,l and l,l,k,l login bursts survive
node test/login-bursts.mjs failed-start # the same after a failed start, then a URL once storage recovers
scripts/local-tailnet.sh # a tailnet of its own: join, dial a peer, half-close, WebSockets to the peer by address and name, nothing inbound, exit node by name and ID
node test/logout-check.mjs # interactive: join, logout, login again; prints sign-in links to /tmp/logout-check.out
```

`scripts/local-tailnet.sh` downloads pinned, sha256-checked headscale 0.29.4 and Tailscale 1.104.1 (Linux x86_64) into a temporary directory, or uses `HEADSCALE`, `TAILSCALED` and `TAILSCALE` when all three are set, and runs `test/local-tailnet.mjs`.

The build uses Tailscale's pinned Go toolchain (`./tool/go`), `-trimpath`, `-buildvcs=false` and an empty build ID, so the same tag, patches and version give the same `main.wasm` on any machine. The version is baked in, so a build outside a release says `0.0.0-dev`.

## Updating

To move to a new Tailscale tag, rebase the patch series onto it. In a Tailscale clone, apply `patches/*.patch` to the old tag with `git am`, rebase onto the new tag, then refresh `patches/` with `git format-patch <new-tag>..HEAD`. Update `upstream.json`, and the Tailscale version `scripts/local-tailnet.sh` downloads. The first release of the new tag is `<new version>-1`.

## CI

[`ci.yml`](.github/workflows/ci.yml) runs [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline) on every pull request, in the merge queue and on `main`. `npm run lint` runs shellcheck and checks that `patches/` applies to the pinned tag; `npm test` builds and runs the tests above, in one job; on a pull request, Claude and Codex review the change.

Every push to `main` with a `fix`, `feat` or `perf` commit since the last release releases, through semantic-release ([`.releaserc.json`](.releaserc.json)). [`scripts/release.mjs`](scripts/release.mjs) picks the version, one past the highest `n` npm has for the tag in `upstream.json`, builds `package/` with it and packs it with this README and the LICENSE. It refuses a tarball whose files aren't the ones this build wrote (by `build-info.json` and by the build's own files), that was built from another commit or version, or that holds links or entries outside `package/`. It publishes that tarball with npm trusted publishing (OIDC) and provenance, under `latest`, and the GitHub release names it. semantic-release keeps its own count in the `release-X.Y.Z` git tags, which only mark what has been released.

## License

BSD 3-Clause, as Tailscale's (see [LICENSE](LICENSE)). The patches are under the same license. `main.wasm` also contains code under Apache-2.0, MIT and BSD licences; see `THIRD-PARTY-NOTICES.md` in the package.
