import {CryoServerWebsocketSession} from "../../CryoServerWebsocketSession/CryoServerWebsocketSession.js";

export interface CryoWebsocketServerOptions {
    keepAliveIntervalMs?: number;
    port?: number;
    backpressure?: BackpressureOpts;
    ssl?: SSLOptions;
    cale: boolean;
}

export interface SSLOptions {
    key: Buffer;
    cert: Buffer;
}

type DropPolicy = "drop-oldest" | "drop-newest" | "dedupe-latest";
export interface BackpressureOpts {
    highWaterMark?: number;
    lowWaterMark?: number;
    maxQueuedBytes?: number;
    maxQueueCount?: number;
    dropPolicy?: DropPolicy;
}
export type FilledBackpressureOpts = Required<BackpressureOpts>;

export interface CryoWebsocketServerEvents {
    "session": (session: CryoServerWebsocketSession) => void;

    "listening": () => void;
}