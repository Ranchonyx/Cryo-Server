import {EventEmitter} from "node:events";
import {DebugLoggerFunction} from "node:util";
import ws from "ws";
import {Duplex} from "node:stream";
import {CreateDebugLogger} from "../Common/Util/CreateDebugLogger.js";
import {AckTracker} from "../Common/AckTracker/AckTracker.js";
import {CryoExtensionRegistry} from "../CryoExtension/CryoExtensionRegistry.js";
import {
    BackpressureManager,
    BackpressureOpts,
    BackpressureProfile
} from "../BackpressureManager/BackpressureManager.js";
import {
    BinaryMessageType,
    BufferUtil,
    ByeFrame,
    EndpointInfoFrame,
} from "cryo-protocol";
import {CryoBaseManager} from "./Namespaces/Cryo.Base.js";
import {CryoTransactionManager} from "./Namespaces/Cryo.Transaction.js";
import {CryoFrameInspector} from "../Common/CryoFrameInspector/CryoFrameInspector.js";
import {CryoWebsocketServerEvents} from "../CryoWebsocketServer/CryoWebsocketServer.js";


export interface ICryoServerWebsocketSessionEvents {
    "message-utf8": (message: string) => Promise<void>;
    "message-binary": (message: Buffer) => Promise<void>;
    "message-error": (message: string) => Promise<void>;

    "stat-rtt": (stat: number) => Promise<void>;
    "stat-ack-timeout": (stat: number) => Promise<void>;
    "stat-bytes-rx": (stat: number) => Promise<void>;
    "stat-bytes-tx": (stat: number) => Promise<void>;

    "connected": () => void;
    "closed": () => void;
}

export interface CryoServerWebsocketSession<TStorageKeys extends string = string> {
    on<U extends keyof ICryoServerWebsocketSessionEvents>(event: U, listener: ICryoServerWebsocketSessionEvents[U]): this;

    emit<U extends keyof ICryoServerWebsocketSessionEvents>(event: U, ...args: Parameters<ICryoServerWebsocketSessionEvents[U]>): boolean;
}

enum CloseCode {
    CLOSE_GRACEFUL = 4000,
    CLOSE_CLIENT_ERROR = 4001,
    CLOSE_SERVER_ERROR = 4002
}

type SocketType = Duplex & { isAlive: boolean, sessionId: bigint };

export class CryoServerWebsocketSession<TStorageKeys extends string = string> extends EventEmitter implements CryoServerWebsocketSession<TStorageKeys> {
    private readonly bp_mgr: BackpressureManager;
    private readonly log: DebugLoggerFunction;
    private readonly client_ack_tracker: AckTracker = new AckTracker();
    private readonly storage: Partial<Record<TStorageKeys, any>> = {};
    private destroyed = false;

    private current_ack = 0;
    private current_txid = 0;

    private bytes_rx = 0;
    private bytes_tx = 0;

    private receivedProtocolFeatures: bigint = 0n;

    public base: CryoBaseManager;
    public stream: CryoTransactionManager | null = null;

    private bind<T extends Function>(func: T): T {
        return func.bind(this);
    }

    private forwardMessageStrOrBuf(source: EventEmitter, event: keyof ICryoServerWebsocketSessionEvents) {
        source.on(event, (message) => this.emit(event, message));
    }

    public constructor(public webSocket: ws & SocketType,
                       private tcpSocket: Duplex,
                       private remoteName: string,
                       backpressure_opts: Required<BackpressureOpts> | BackpressureProfile,
                       private extensionRegistry: CryoExtensionRegistry
    ) {
        super();
        this.log = CreateDebugLogger(`CRYO_SERVER_SESSION`);

        this.bp_mgr = new BackpressureManager(webSocket, backpressure_opts, CreateDebugLogger(`CRYO_BACKPRESSURE`));
        this.base = new CryoBaseManager(
            this.sid,
            this.bind(this.send),
            this.bind(this.next_ack),
            this.bind(this.Destroy),
            (features) => this.receivedProtocolFeatures = features,
            this.extensionRegistry.get_executor(this),
            this.client_ack_tracker,
            () => this.webSocket.isAlive = true
        );

        this.forwardMessageStrOrBuf(this.base, "message-binary");
        this.forwardMessageStrOrBuf(this.base, "message-utf8");
        this.forwardMessageStrOrBuf(this.base, "message-error");
        //set up listeners
        tcpSocket.once("end", this.TCPSOCKET_HandleRemoteEnd.bind(this));
        tcpSocket.once("error", this.TCPSOCKET_HandleRemoteError.bind(this));
        webSocket.on("close", this.WEBSOCKET_HandleRemoteClose.bind(this));

        //Handle incoming ws messages
        webSocket.on("message", async (raw: Buffer) => {
            this.bytes_rx += raw.byteLength;
            this.routeFrame(raw)
                .catch((err) => {
                    this.log(`routeFrame failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
                });
        });

        //Send the first endpointInfo message
        const msg = EndpointInfoFrame.Serialize(this.sid, this.next_ack());
        this.send(msg);

        this.base.on("ready", () => {
            this.stream = new CryoTransactionManager(
                this.sid,
                this.bind(this.send),
                this.bind(this.next_ack),
                this.bind(this.next_txid),
                this.bind(this.Destroy),
                () => this.receivedProtocolFeatures,
                this.bp_mgr.waitUntilEmpty.bind(this.bp_mgr)
            );
        });

        this.emit("connected");
    }

    private async routeFrame(frame: Buffer) {
        const type = BufferUtil.GetType(frame);

        if (type >= BinaryMessageType.BINARYDATA && type <= BinaryMessageType.ENDPOINT_INFO)
            return this.base.handle(frame);

        if (type >= BinaryMessageType.TX_START && type <= BinaryMessageType.TX_CANCEL)
            return this.stream?.handle(frame);

        throw new Error(`Unknown frame type ${type}!`);
    }

    private next_ack(): number {
        if (this.current_ack + 1 > 0xffffffff)
            this.current_ack = 0;

        return this.current_ack++;
    }

    private next_txid(): number {
        if (this.current_txid + 1 > 0xffffffff)
            this.current_txid = 0;

        return this.current_txid++;
    }

    private TranslateCloseCode(code: number): string {
        switch (code as CloseCode) {
            case CloseCode.CLOSE_GRACEFUL:
                return "Connection closed normally.";
            case CloseCode.CLOSE_CLIENT_ERROR:
                return "Connection closed due to a client error.";
            case CloseCode.CLOSE_SERVER_ERROR:
                return "Connection closed due to a server error.";
            default:
                return "Unspecified cause for connection closure."
        }
    }

    private async send(outgoing_message: Buffer, payload?: string | Buffer) {
        if (this.destroyed)
            return;

        let ackPromise: PromiseWithResolvers<void> | null = null;

        //Create a pending message with a new ack number and queue it for acknowledgement by the client
        const type = BufferUtil.GetType(outgoing_message);
        if (
            type === BinaryMessageType.UTF8DATA ||
            type === BinaryMessageType.BINARYDATA ||
            type === BinaryMessageType.ERROR ||
            type === BinaryMessageType.ENDPOINT_INFO ||
            type === BinaryMessageType.TX_FLOW ||
            type === BinaryMessageType.TX_START ||
            type === BinaryMessageType.TX_FINISH ||
            type === BinaryMessageType.TX_FETCH
        ) {
            const message_ack = BufferUtil.GetAck(outgoing_message);
            ackPromise = Promise.withResolvers<void>();
            this.client_ack_tracker.Track(message_ack, {
                timestamp: Date.now(),
                message: outgoing_message,
                ackPromise,
                payload
            });
        }

        this.log(`OUT ${CryoFrameInspector.Inspect(outgoing_message)}`);
        if (!ackPromise)
            return Promise.resolve();

        //Spin until we can send again
        while (true) {
            //Try enqueueing the outgoing message
            const ok = this.bp_mgr!.enqueue(outgoing_message);
            if (ok) {
                this.bytes_tx += outgoing_message.byteLength;
                return ackPromise.promise;
            }

            //If we were unable, wait until we can enqueue again
            await this.bp_mgr.spinUntilWritable();
        }

    }

    public get_ack_tracker(): AckTracker {
        return this.client_ack_tracker;
    }

    //noinspection JSUnusedGlobalSymbols
    public get rx(): number {
        return this.bytes_rx;
    }

    //noinspection JSUnusedGlobalSymbols
    public get tx(): number {
        return this.bytes_tx;
    }

    //noinspection JSUnusedGlobalSymbols
    public get sid(): bigint {
        return this.webSocket.sessionId;
    }

    //noinspection JSUnusedGlobalSymbols
    public async Close(reason: string) {
        const ack = this.next_ack();
        const frame = ByeFrame.Serialize(this.sid, ack, reason);
        this.client_ack_tracker.Track(ack, {message: frame, timestamp: Date.now()});
        await this.send(frame);

        this.Destroy();
    }

    /*
    Session runtime storage API
    */

    /**
     * @param key Storage key to set to a value
     * @param value The value to write into the key
     * */
    public Set(key: TStorageKeys, value: any): void {
        this.storage[key] = value;
    }

    /**
     * @param key Storage key to retrieve data from
     * */
    public Get<T>(key: TStorageKeys): T {
        return this.storage[key] as T;
    }

    /*
    Error handling
    */

    private WEBSOCKET_HandleRemoteClose(code: number, reason: Buffer) {
        const code_string = this.TranslateCloseCode(code);
        this.log(`Client ${this.remoteName} has disconnected. Code=${code_string}, reason=${reason.toString("utf8")}`);
        this.Destroy(CloseCode.CLOSE_GRACEFUL, "Connection closed gracefully.");
    }

    private TCPSOCKET_HandleRemoteEnd() {
        this.log(`TCP Peer '${this.remoteName}' connection closed cleanly by client session.`);
        this.Destroy(CloseCode.CLOSE_GRACEFUL, "Connection closed gracefully.");
    }

    private TCPSOCKET_HandleRemoteError(err: Error) {
        this.log(`TCP Peer '${this.remoteName}' threw an error '${err.message}' (${(err as Error & {
            code?: string
        })?.code})`)
        this.Destroy(CloseCode.CLOSE_CLIENT_ERROR, "Connection closed erroneously.");
    }

    //noinspection JSUnusedGlobalSymbols
    private Destroy(code: number = 4000, message: string = "Closing session.") {
        this.bp_mgr?.Destroy();
        this.client_ack_tracker?.Destroy();
        try {
            this.log(`Teardown of session. Code=${code}, reason=${message}`);
            this.webSocket.close(code, message);
        } catch {
            //Ignore
        }

        if (!this.destroyed)
            this.emit("closed");

        this.destroyed = true;
    }
}
