declare global {
  class Go {
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): Promise<void>;
  }
  /** An Error instead of a node when the backend can't be built (for example, stateStorage threw). */
  function newIPN(config: IPNConfig): IPN | Error;
}

export interface IPNConfig {
  /**
   * Where the node keeps its state: `_machinekey`, `log-policy` and the
   * profile, which with `ephemeral: false` holds the node's private key.
   * Treat it as a secret. The auth key is never written here. Called
   * synchronously from Go: don't call back into the IPN from it.
   */
  stateStorage?: { getState(id: string): string; setState(id: string, value: string): void };
  /** Used for one login only, never stored. */
  authKey?: string;
  controlURL?: string;
  hostname?: string;
  exitNode?: string;
  ephemeral?: boolean;
  logUpload?: boolean;
}

/** Delivered asynchronously, in order, each on its own JS task. One that throws is reported through notifyPanicRecover; the node keeps running. */
export interface IPNCallbacks {
  notifyState(state: string): void;
  notifyNetMap(netMap: string): void;
  notifyBrowseToURL(url: string): void;
  /** A callback that threw, or "Tailscale could not start: …" when run()'s start failed. */
  notifyPanicRecover(error: string): void;
}

export interface IPNResponse {
  status: number;
  statusText: string;
  url: string;
  headers: [string, string][];
  read(): Promise<Uint8Array | null>;
  cancel(): void;
}

export interface IPNConn {
  localAddr: string;
  remoteAddr: string;
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<number>;
  /** shutdown(SHUT_WR): the peer reads the end of the stream. */
  closeWrite(): void;
  close(): void;
}

/**
 * A node with shields up (peers can't connect to it) that accepts subnet
 * routes: RouteAll is true, unlike upstream tsconnect, so traffic to a route
 * another node advertises goes to that peer, not to the exit node.
 */
export interface IPN {
  run(callbacks: IPNCallbacks): void;
  /** Refused before run(); waits for run()'s start (and runs it again if it failed), and re-applies shields up, the control URL, hostname and routes first. */
  login(authKey?: string): void;
  logout(): void;
  fetch(request: {
    url: string;
    method?: string;
    headers?: [string, string][];
    body?: Uint8Array;
    manualRedirects?: boolean;
    encodedBodies?: boolean;
  }): Promise<IPNResponse>;
  dial(network: 'tcp' | 'udp', addr: string): Promise<IPNConn>;
  setExitNode(expr: string): Promise<void>;
  /** JSON. Safe in the notify* callbacks (they run on their own task); returns an Error inside stateStorage callbacks instead of hanging. */
  status(): string | Error;
}
