import {Store} from "express-session";
import {ISecretGenerator} from "./ISecretGenerator.js";
import {ISessionIDGenerator} from "./ISessionIDGenerator.js";
import {CryoServerWebsocketSession} from "../CryoWebsocketSession/CryoServerWebsocketSession.js";

export type CryoWebsocketServerOptions = {
    sessionStore?: Store;
    secretGenerator?: ISecretGenerator;
    sessionIDGenerator?: ISessionIDGenerator;
    keepAliveIntervalMs?: number;
    socketPath?: string;
    port?: number;
}

export interface CryoWebsocketServerEvents {
    "session": (session: CryoServerWebsocketSession) => void;

    "listening": () => void;
}