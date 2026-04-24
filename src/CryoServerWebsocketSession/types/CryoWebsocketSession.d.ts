export interface ICryoServerWebsocketSessionEvents {
    "message-utf8": (message: string) => Promise<void>;
    "message-binary": (message: Buffer) => Promise<void>;

    "stat-rtt": (stat: number) => Promise<void>;
    "stat-ack-timeout": (stat: number) => Promise<void>;
    "stat-bytes-rx": (stat: number) => Promise<void>;
    "stat-bytes-tx": (stat: number) => Promise<void>;

    "connected": () => void;
    "closed": () => void;

    "tx-start": (txId: number, txName: string) => Promise<void>;
    "tx-chunk": (txId: number, data: Buffer) => Promise<void>;
    "tx-finish": (txId: number) => Promise<void>;
}