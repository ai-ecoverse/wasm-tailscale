declare global {
  class Go {
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): Promise<void>;
  }
  function newIPN(config: IPNConfig): IPN;
}

export interface IPNConfig {
  stateStorage?: { getState(id: string): string; setState(id: string, value: string): void };
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

export interface IPN {
  run(callbacks: IPNCallbacks): void;
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
