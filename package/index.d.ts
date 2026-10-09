declare global {
  class Go {
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): Promise<void>;
  }
  function newIPN(config: IPNConfig): IPN;
}

export interface IPNConfig {
  /**
   * Where the node keeps its state: `_machinekey`, `log-policy` and the
   * profile, which with `ephemeral: false` holds the node's private key.
   * Treat it as a secret. The auth key is never written here.
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

export interface IPNCallbacks {
  notifyState(state: string): void;
  notifyNetMap(netMap: string): void;
  notifyBrowseToURL(url: string): void;
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
  close(): void;
}

/**
 * A node with shields up (peers can't connect to it) that accepts subnet
 * routes: RouteAll is true, unlike upstream tsconnect, so traffic to a route
 * another node advertises goes to that peer, not to the exit node.
 */
export interface IPN {
  run(callbacks: IPNCallbacks): void;
  /** Refused before run(). With a key, shields are set up again before logging in. */
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
  status(): string;
}
