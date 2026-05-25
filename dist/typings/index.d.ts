import type {EventEmitter} from "node:events";
import type http from "node:http";
import type {Readable} from "node:stream";
import {CRYO_FLOW_BEHAVIOUR} from "cryo-protocol";

/**
 * CryoServerWebsocketSession typings
 * */
export declare interface ICryoServerWebsocketSessionEvents {
    "message-utf8": (message: string) => Promise<void>;
    "message-binary": (message: Buffer) => Promise<void>;
    "stat-rtt": (stat: number) => Promise<void>;
    "stat-ack-timeout": (stat: number) => Promise<void>;
    "stat-bytes-rx": (stat: number) => Promise<void>;
    "stat-bytes-tx": (stat: number) => Promise<void>;

    "closed": () => void;
}

export declare type CryoWebsocketSessionDefaultMetadata = {
    sid: bigint;
}

export declare interface CryoServerWebsocketSession<TStorageKeys extends string = string> {
    on<U extends keyof ICryoServerWebsocketSessionEvents>(event: U, listener: ICryoServerWebsocketSessionEvents[U]): this;

    emit<U extends keyof ICryoServerWebsocketSessionEvents>(event: U, ...args: Parameters<ICryoServerWebsocketSessionEvents[U]>): boolean;
}

export declare class CryoServerWebsocketSession<TStorageKeys extends string = string> extends EventEmitter implements CryoServerWebsocketSession<TStorageKeys> {
    public SendPing(): Promise<void>;

    public SendUTF8(message: string): Promise<void>;

    public SendBinary(message: Buffer): Promise<void>

    public Stream(source: Readable, streamName?: string): Promise<void>;

    public WaitForStream(streamName?: string, timeout?: number): Promise<Readable>;

    public async SetIncomingFlowControl(behaviour: CRYO_FLOW_BEHAVIOUR): Promise<void>

    public Destroy(): void;

    public Set(key: TStorageKeys, value: any): void;

    public Get<T>(key: TStorageKeys): T;

    public get id(): bigint;
}


type Box<T> = { value: T };

export declare interface ICryoExtension {

    /**
     * Executed upon registration of the extension on the server
     * @param server - Reference to the running cryo websocket server
     * */
    on_register(server: CryoWebsocketServer): void;

    /**
     * Executed upon unregistration of the extension on the server
     * @param server - Reference to the running cryo websocket server
     * */
    on_unregister(server: CryoWebsocketServer): void;

    /**
     * Executed before a binary message is sent to the client session
     * @param session - The cryo websocket session
     * @param outgoing_message - The message buffer to be sent to the client
     * */
    before_send_binary?(session: CryoServerWebsocketSession, outgoing_message: Box<Buffer>): Promise<boolean>;

    /**
     * Executed before a text message is sent to the client session
     * @param session - The cryo websocket session
     * @param outgoing_message - The message text to be sent to the client
     * */
    before_send_utf8?(session: CryoServerWebsocketSession, outgoing_message: Box<string>): Promise<boolean>;

    /**
     * Executed after a binary message is received from the client, but before the session can emit the `message-binary` event
     * @param session - The cryo websocket session
     * @param incoming_message - The incoming binary message from the client
     * */
    on_receive_binary?(session: CryoServerWebsocketSession, incoming_message: Box<Buffer>): Promise<boolean>;

    /**
     * Executed after a text message is received from the client, but before the session can emit the `message-utf8` event
     * @param session - The cryo websocket session
     * @param incoming_message - The incoming text message from the client
     * */
    on_receive_utf8?(session: CryoServerWebsocketSession, incoming_message: Box<string>): Promise<boolean>;

    /**
     * The unique name of this extension
     * */
    name: string;
}

/**
 * CryoWebsocketServer typings
 * */
export declare interface ITokenValidator {
    validate(token: string): Promise<boolean>;
}

export declare type DropPolicy = "drop-oldest" | "drop-newest" | "dedupe-latest";

export interface BackpressureOpts {
    HIGH_WATERMARK: number;
    LOW_WATERMARK: number;
    MAX_QUEUED_BYTES: number;
    MAX_QUEUE_SIZE: number;
    DROP_POLICY: DropPolicy;
}

export interface SSLOptions {
    key: Buffer;
    cert: Buffer;
}

/**
 * optimize_latency: small buffers, lower queueing delay
 *
 * optimize_memory: strict capacities, lowest mem usage
 *
 * default: fairly balanced throughput and memory use
 * */
export type BackpressureProfile = "optimize_latency" | "optimize_memory" | "default";

export interface ICryoWebsocketServerOptions {
    keepAliveIntervalMs?: number;
    port?: number;
    backpressure?: BackpressureProfile | BackpressureOpts;
    ssl?: SSLOptions;
}

export declare interface CryoWebsocketServerEvents {
    "session": (session: CryoServerWebsocketSession) => void;

    "listening": () => void;
}

export declare interface CryoWebsocketServer {
    on<U extends keyof CryoWebsocketServerEvents>(event: U, listener: CryoWebsocketServerEvents[U]): this;

    emit<U extends keyof CryoWebsocketServerEvents>(event: U, ...args: Parameters<CryoWebsocketServerEvents[U]>): boolean;
}

export declare class CryoWebsocketServer extends EventEmitter implements CryoWebsocketServer {
    public Destroy(): void;

    public RegisterExtension(extension: ICryoExtension): void;

    public UnregisterExtension(extension: ICryoExtension): void;

    public GetExtension(extensionName: string): ICryoExtension | null;

    public ConnectPeer(host: string, bearer: string): Promise<CryoServerWebsocketSession>;

    public get http_server(): http.Server;
}

/**
 * Create a Cryo server
 * @param pTokenValidator - An implementation of the {@link ITokenValidator} interface to validate incoming websocket connections
 * @param options - Optional arguments, {@link CryoWebsocketServerOptions}
 * */
export declare function cryo(pTokenValidator: ITokenValidator, options?: ICryoWebsocketServerOptions): CryoWebsocketServer;
