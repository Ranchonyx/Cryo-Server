import {EventEmitter} from "node:events";
import {UUID} from "node:crypto";
import {Store} from "express-session";
import http from "node:http";
import {CryoExtension} from "../../src/CryoExtension/CryoExtension";

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
    public SendPing(): Promise<void>;

    public SendUTF8(message: string): Promise<void>;

    public SendBinary(message: Buffer): Promise<void>

    public Destroy(): void;
}

export interface CryoExtension {

    /**
     * Executed before a binary message is sent to the client session
     * @param session - The cryo websocket session
     * @param outgoing_message - The message buffer to be sent to the client
     * */
    before_send_binary?(session: CryoServerWebsocketSession, outgoing_message: Buffer): Promise<boolean>;

    /**
     * Executed before a text message is sent to the client session
     * @param session - The cryo websocket session
     * @param outgoing_message - The message text to be sent to the client
     * */
    before_send_utf8?(session: CryoServerWebsocketSession, outgoing_message: string): Promise<boolean>;

    /**
     * Executed after a binary message is received from the client, but before the session can emit the `message-binary` event
     * @param session - The cryo websocket session
     * @param incoming_message - The incoming binary message from the client
     * */
    on_receive_binary?(session: CryoServerWebsocketSession, incoming_message: Buffer): Promise<boolean>;

    /**
     * Executed after a text message is received from the client, but before the session can emit the `message-utf8` event
     * @param session - The cryo websocket session
     * @param incoming_message - The incoming text message from the client
     * */
    on_receive_utf8?(session: CryoServerWebsocketSession, incoming_message: string): Promise<boolean>;

    /**
     * The unique name of this extension
     * */
    name: string;
}

/**
 * CryoWebsocketServer typings
 * */
export interface ITokenValidator {
    validate(token: string): Promise<boolean>;
}

export type CryoWebsocketServerOptions = {
    keepAliveIntervalMs?: number;
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

    public RegisterExtension(extension: CryoExtension): void;
    public get http_server(): http.Server;
}

/**
 * Create a Cryo server
 * @param pTokenValidator - An implementation of the {@link ITokenValidator} interface to validate incoming websocket connections
 * @param options - Optional arguments, {@link CryoWebsocketServerOptions}
 * */
export declare function cryo(pTokenValidator: ITokenValidator, options?: CryoWebsocketServerOptions): Promise<CryoWebsocketServer>;
