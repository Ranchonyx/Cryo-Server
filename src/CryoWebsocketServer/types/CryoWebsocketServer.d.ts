import {CryoServerWebsocketSession} from "../CryoWebsocketSession/CryoServerWebsocketSession.js";

export type CryoWebsocketServerOptions = {
    keepAliveIntervalMs?: number;
    port?: number;
}

export interface CryoWebsocketServerEvents {
    "session": (session: CryoServerWebsocketSession) => void;

    "listening": () => void;
}