import {Express, Request} from "express";
import {EventEmitter} from "node:events";
import {UUID} from "node:crypto";
import {Store} from "express-session";

/**
 * CryoServerWebsocketSession typings
 * */
export interface ICryoServerWebsocketSessionEvents {
    "message-utf8": (message: string) => Promise<void>;
    "message-binary": (message: Buffer) => Promise<void>;

    "closed": () => void;
}

export type CryoWebsocketSessionDefaultMetadata = {
    sid: UUID;
}

export interface CryoServerWebsocketSession {
    on<U extends keyof ICryoServerWebsocketSessionEvents>(event: U, listener: ICryoServerWebsocketSessionEvents[U]): this;

    emit<U extends keyof ICryoServerWebsocketSessionEvents>(event: U, ...args: Parameters<ICryoServerWebsocketSessionEvents[U]>): boolean;
}

export declare class CryoServerWebsocketSession extends EventEmitter implements CryoServerWebsocketSession {
    public async SendPing(): Promise<void>;

    public async SendUTF8(message: string): Promise<void>;

    public async SendBinary(message: Buffer): Promise<void>

    public Destroy(): void;
}

/**
 * CryoWebsocketServer typings
 * */
export interface ISecretGenerator {
    generate(): Promise<string>;
}

export interface ISessionIDGenerator {
    generate(req: Request): string;
}

export interface ITokenValidator {
    validate(token: string): Promise<boolean>;
}

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

export interface CryoWebsocketServer {
    on<U extends keyof CryoWebsocketServerEvents>(event: U, listener: CryoWebsocketServerEvents[U]): this;

    emit<U extends keyof CryoWebsocketServerEvents>(event: U, ...args: Parameters<CryoWebsocketServerEvents[U]>): boolean;
}

export declare class CryoWebsocketServer extends EventEmitter implements CryoWebsocketServer {
    public Destroy(): void;
}

/**
 * Create a Cryo server and attach it to an Express.js app
 * @param pApp - The express app to attach the server to
 * @param pTokenValidator - An implementation of the {@link ITokenValidator} interface to validate incoming websocket connections
 * @param options - Optional arguments, {@link CryoWebsocketServerOptions}
 * */
export declare function cryo(pApp: Express, pTokenValidator: ITokenValidator, options?: CryoWebsocketServerOptions): Promise<CryoWebsocketServer>;
