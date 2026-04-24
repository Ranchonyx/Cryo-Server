import {EventEmitter} from "node:events";
import {DebugLoggerFunction} from "node:util";
import ws from "ws";
import {Duplex, Readable} from "node:stream";
import {ICryoServerWebsocketSessionEvents} from "./types/CryoWebsocketSession.js";
import {UUID} from "node:crypto";
import {CreateDebugLogger} from "../Common/Util/CreateDebugLogger.js";
import {AckTracker} from "../Common/AckTracker/AckTracker.js";
import {CryoExtensionRegistry} from "../CryoExtension/CryoExtensionRegistry.js";
import {FilledBackpressureOpts} from "../CryoWebsocketServer/types/CryoWebsocketServer.js";
import {BackpressureManager} from "../Common/BackpressureManager/BackpressureManager.js";
import {BufferUtil} from "../Common/Protocol/BufferUtil.js";
import {BinaryMessageType} from "../Common/Protocol/defs.js";
import {PingPongFrame} from "../Common/Protocol/Basic/PingPongFrame.js";
import {Utf8DataFrame} from "../Common/Protocol/Basic/Utf8DataFrame.js";
import {BinaryDataFrame} from "../Common/Protocol/Basic/BinaryDataFrame.js";
import {ErrorFrame} from "../Common/Protocol/Basic/ErrorFrame.js";
import {ACKFrame} from "../Common/Protocol/Basic/ACKFrame.js";
import {TXStartFrame} from "../Common/Protocol/Transaction/TXStartFrame.js";
import {TXFinishFrame} from "../Common/Protocol/Transaction/TXFinishFrame.js";
import {TXChunkFrame} from "../Common/Protocol/Transaction/TXChunkFrame.js";

type SocketType = Duplex & { isAlive: boolean, sessionId: UUID };

export interface CryoServerWebsocketSession<TStorageKeys extends string = string> {
    on<U extends keyof ICryoServerWebsocketSessionEvents>(event: U, listener: ICryoServerWebsocketSessionEvents[U]): this;

    emit<U extends keyof ICryoServerWebsocketSessionEvents>(event: U, ...args: Parameters<ICryoServerWebsocketSessionEvents[U]>): boolean;
}

enum CloseCode {
    CLOSE_GRACEFUL = 4000,
    CLOSE_CLIENT_ERROR = 4001,
    CLOSE_SERVER_ERROR = 4002
}

function handleTrans(session: CryoServerWebsocketSession, callback: (destination: Readable) => Promise<void> | void) {
    const streams = new Map<number, Readable>;

    async function onTxStart(incomingTxId: number) {
        console.info(`tx-start, txid: ${incomingTxId}`)
        const stream = new Readable({
            read() {
            }
        });

        //Handle stream
        stream.on("close", () => {
            streams.delete(incomingTxId);
        });

        streams.set(incomingTxId, stream);
        callback(stream);
    }

    async function onTxFinish(incomingTxId: number) {
        console.info(`tx-finish, txid: ${incomingTxId}`)
        if (!streams.has(incomingTxId))
            return;

        streams.get(incomingTxId)!.push(null);
    }

    async function onTxChunk(incomingTxId: number, data: Buffer) {
        console.info(`tx-chunk, txid: ${incomingTxId}, sz: ${data.byteLength}`);
        if (!streams.has(incomingTxId))
            return;

        streams.get(incomingTxId)!.push(data);
    }

    session.on("tx-start", onTxStart);
    session.on("tx-finish", onTxFinish);
    session.on("tx-chunk", onTxChunk);
}

export class CryoServerWebsocketSession<TStorageKeys extends string = string> extends EventEmitter implements CryoServerWebsocketSession<TStorageKeys> {
    private readonly bp_mgr: BackpressureManager | null = null;
    private readonly log: DebugLoggerFunction;
    private readonly client_ack_tracker: AckTracker = new AckTracker();
    private readonly storage: Partial<Record<TStorageKeys, any>> = {};
    private readonly streams = new Map<number, Readable>;

    private destroyed = false;

    private current_ack = 0;
    private current_txid = 0;

    private bytes_rx = 0;
    private bytes_tx = 0;

    public constructor(private remoteClient: ws & SocketType,
                       private remoteSocket: Duplex,
                       private remoteName: string,
                       backpressure_opts: FilledBackpressureOpts,
                       private extensionRegistry: CryoExtensionRegistry
    ) {
        super();
        this.log = CreateDebugLogger(`CRYO_SERVER_SESSION`);

        this.bp_mgr = new BackpressureManager(remoteClient, backpressure_opts.highWaterMark, backpressure_opts.lowWaterMark, backpressure_opts.maxQueuedBytes, backpressure_opts.maxQueueCount, backpressure_opts.dropPolicy, CreateDebugLogger(`CRYO_BACKPRESSURE`));

        remoteSocket.once("end", this.TCPSOCKET_HandleRemoteEnd.bind(this));
        remoteSocket.once("error", this.TCPSOCKET_HandleRemoteError.bind(this));
        remoteClient.on("close", this.WEBSOCKET_HandleRemoteClose.bind(this));
        remoteClient.on("message", async (raw: Buffer) => {
            this.bytes_rx += raw.byteLength;
            this.routeFrame(raw).catch((err) => {
                this.log(`routeFrame failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
            });
        });
    }

    private async routeFrame(frame: Buffer) {
        const type = BufferUtil.GetType(frame);

        switch (type) {
            case BinaryMessageType.PING_PONG:
                await this.HandlePingPongMessage(frame);
                return;
            case BinaryMessageType.ERROR:
                await this.HandleErrorMessage(frame);
                return;
            case BinaryMessageType.ACK:
                await this.HandleAckMessage(frame);
                return;
            case BinaryMessageType.UTF8DATA:
                await this.HandleUTF8DataMessage(frame);
                return;
            case BinaryMessageType.BINARYDATA:
                await this.HandleBinaryDataMessage(frame);
                return;
            case BinaryMessageType.TX_START:
                await this.HandleTxStartMessage(frame);
                return;
            case BinaryMessageType.TX_CHUNK:
                await this.HandleTxChunkMessage(frame);
                return;
            case BinaryMessageType.TX_FINISH:
                await this.HandleTxFinishMessage(frame);
                return;
            default:
                this.log(`Unsupported binary message type ${type}!`);
        }
    }

    private inc_get_ack(): number {
        if (this.current_ack + 1 > 0xffffffff)
            this.current_ack = 0;

        return this.current_ack++;
    }

    private inc_get_txid(): number {
        if (this.current_txid + 1 > 0xffffffff)
            this.current_txid = 0;

        return this.current_txid++;
    }

    /*
    * Sends a PING frame to the client
    * */
    public async Ping(): Promise<void> {
        const new_ack_id = this.inc_get_ack();

        const encodedPingMessage = PingPongFrame
            .Serialize(this.Client.sessionId, new_ack_id, "ping");

        await this.Send(encodedPingMessage);
    }

    /*
    * Send an UTF8 string to the client
    * */

    //noinspection JSUnusedGlobalSymbols
    public async SendUTF8(message: string): Promise<void> {
        const new_ack_id = this.inc_get_ack();
        const boxed_message = {value: message};

        const result = await this.extensionRegistry
            .get_executor(this)
            .apply_before_send(boxed_message);

        if (!result.should_emit)
            return;

        const encodedUtf8DataMessage = Utf8DataFrame
            .Serialize(this.Client.sessionId, new_ack_id, boxed_message.value);

        this.client_ack_tracker.Track(new_ack_id, {
            message: encodedUtf8DataMessage,
            timestamp: Date.now(),
            payload: boxed_message.value
        });

        await this.Send(encodedUtf8DataMessage);
    }

    /*
    * Send a binary message to the client
    * */

    //noinspection JSUnusedGlobalSymbols
    public async SendBinary(message: Buffer): Promise<void> {
        const new_ack_id = this.inc_get_ack();
        const boxed_message = {value: message};

        const result = await this.extensionRegistry
            .get_executor(this)
            .apply_before_send(boxed_message);

        if (!result.should_emit)
            return;

        const encodedBinaryDataMessage = BinaryDataFrame
            .Serialize(this.Client.sessionId, new_ack_id, boxed_message.value);

        this.client_ack_tracker.Track(new_ack_id, {
            message: encodedBinaryDataMessage,
            timestamp: Date.now(),
            payload: boxed_message.value
        });

        await this.Send(encodedBinaryDataMessage);
    }

    public async WaitForStream(streamName: string = "anonymous", timeout: number = 1000): Promise<Readable> {
        const timeoutSig = AbortSignal.timeout(timeout);

        return new Promise<Readable>((resolve, reject) => {
            const onTxStartListener = async (txId: number, txName: string) => {
                if (txName === streamName) {
                    if (!this.streams.has(txId)) {
                        this.off("tx-start", onTxStartListener);
                        timeoutSig.removeEventListener("abort", onAbort);

                        reject(new Error(`No stream id ${txId} present!`));
                    }

                    const stream = this.streams.get(txId)!;

                    //Remove this listener once the stream has been read
                    stream.on("close", () => {
                        this.off("tx-start", onTxStartListener);
                    })

                    resolve(stream);
                }
            }

            const onAbort = () => {
                this.off("tx-start", onTxStartListener);
                timeoutSig.removeEventListener("abort", onAbort);
                reject(new Error(`Timeout elapsed!`));
            }

            this.on("tx-start", onTxStartListener);
            timeoutSig.addEventListener("abort", onAbort);
        });
    }

    public async Stream(source: Readable, streamName: string = "anonymous") {
        return new Promise<void>((resolve, reject) => {

            const new_ack_id = this.inc_get_ack();
            const new_txid = this.inc_get_txid();

            const start_frame = TXStartFrame.Serialize(this.Client.sessionId, new_ack_id, new_txid, streamName);
            this.Send(start_frame);

            source.on("data", (chunk: Buffer) => {
                const chunk_frame = TXChunkFrame.Serialize(this.Client.sessionId, new_txid, chunk);
                this.Send(chunk_frame);
            });

            source.on("end", () => {
                const finish_frame = TXFinishFrame.Serialize(this.Client.sessionId, this.inc_get_ack(), new_txid);
                this.Send(finish_frame);
                resolve();
            })

            source.on("error", (err) => {
                reject(err);
            })
        });
    }

    /*
    * Respond to PING & PONG frames and set the client to be alive
    * */
    private async HandlePingPongMessage(message: Buffer): Promise<void> {
        const decodedPingPongMessage = PingPongFrame
            .Deserialize(message);

        //A peer is pinging us, play nice and respond
        if (decodedPingPongMessage.payload === "ping") {
            const outgoingPong = PingPongFrame.Serialize(this.Client.sessionId, decodedPingPongMessage.ack, "pong");
            await this.Send(outgoingPong);
        } else {
            //A normal client responded to our ping
            this.Client.isAlive = true;
        }
    }

    /*
    * Handling of binary error messages from the client, currently just log it
    * */
    private async HandleErrorMessage(message: Buffer): Promise<void> {
        const decodedErrorMessage = ErrorFrame
            .Deserialize(message);

        this.log(decodedErrorMessage.payload);
    }

    /*
    * Handle ACK messages from the client
    * */
    private async HandleAckMessage(message: Buffer): Promise<void> {
        const decodedAckMessage = ACKFrame
            .Deserialize(message);

        const ack_id = decodedAckMessage.ack;
        const found_message = this.client_ack_tracker.Confirm(ack_id);

        if (!found_message) {
            this.log(`Received ACK ${ack_id} for unknown message!`);
            return;
        }

        this.log(`Acknowledging client message ${ack_id} !`);
    }

    /*
    * Handle DATA messages from the client
    * */
    private async HandleUTF8DataMessage(message: Buffer): Promise<void> {
        const decodedDataMessage = Utf8DataFrame
            .Deserialize(message);

        const ack_id = decodedDataMessage.ack;
        const encodedACKMessage = ACKFrame
            .Serialize(this.Client.sessionId, ack_id);

        await this.Send(encodedACKMessage);

        const boxed_message = {value: decodedDataMessage.payload};
        const result = await this.extensionRegistry
            .get_executor(this)
            .apply_after_receive(boxed_message);

        if (result.should_emit)
            this.emit("message-utf8", boxed_message.value);
    }

    /*
    * Handle DATA messages from the client
    * */
    private async HandleBinaryDataMessage(message: Buffer): Promise<void> {
        const decodedDataMessage = BinaryDataFrame
            .Deserialize(message);

        const ack_id = decodedDataMessage.ack;
        const encodedACKMessage = ACKFrame
            .Serialize(this.Client.sessionId, ack_id);

        await this.Send(encodedACKMessage);

        const boxed_message = {value: decodedDataMessage.payload};
        const result = await this.extensionRegistry
            .get_executor(this)
            .apply_after_receive(boxed_message);

        if (result.should_emit)
            this.emit("message-binary", boxed_message.value);
    }

    private async HandleTxStartMessage(message: Buffer): Promise<void> {
        const decodedStartFrame = TXStartFrame
            .Deserialize(message);

        const ack_id = decodedStartFrame.ack;
        const encodedACKMessage = ACKFrame
            .Serialize(this.Client.sessionId, ack_id);

        await this.Send(encodedACKMessage);

        const stream = new Readable({
            read() {
            }
        });

        //Handle stream
        stream.on("close", () => {
            this.streams.delete(decodedStartFrame.txId);
        });
        this.streams.set(decodedStartFrame.txId, stream);

        this.emit("tx-start", decodedStartFrame.txId, decodedStartFrame.txName);
    }

    private async HandleTxFinishMessage(message: Buffer): Promise<void> {
        const decodedFinishFrame = TXFinishFrame
            .Deserialize(message);

        const ack_id = decodedFinishFrame.ack;
        const encodedACKMessage = ACKFrame
            .Serialize(this.Client.sessionId, ack_id);

        await this.Send(encodedACKMessage);

        //Handle stream
        if (!this.streams.has(decodedFinishFrame.txId))
            return;
        this.streams.get(decodedFinishFrame.txId)!.push(null);

        this.emit("tx-finish", decodedFinishFrame.txId);
    }

    private async HandleTxChunkMessage(message: Buffer): Promise<void> {
        const decodedChunkFrame = TXChunkFrame
            .Deserialize(message);

        //Handle stream
        if (!this.streams.has(decodedChunkFrame.txId))
            return;
        this.streams.get(decodedChunkFrame.txId)!.push(decodedChunkFrame.payload);

        this.emit("tx-chunk", decodedChunkFrame.txId, decodedChunkFrame.payload);
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

    private WEBSOCKET_HandleRemoteClose(code: number, reason: Buffer) {
        const code_string = this.TranslateCloseCode(code);
        this.log(`Client ${this.remoteName} has disconnected. Code=${code_string}, reason=${reason.toString("utf8")}`);

        this.Destroy(CloseCode.CLOSE_GRACEFUL, "Connection closed gracefully.");
    }

    /*
    * Log hangup and destroy session
    * */
    private TCPSOCKET_HandleRemoteEnd() {
        this.log(`TCP Peer '${this.remoteName}' connection closed cleanly by client session.`);
        this.Destroy(CloseCode.CLOSE_GRACEFUL, "Connection closed gracefully.");
    }

    /*
    * Log error and destroy session
    * */
    private TCPSOCKET_HandleRemoteError(err: Error) {
        this.log(`TCP Peer '${this.remoteName}' threw an error '${err.message}' (${(err as Error & {
            code?: string
        })?.code})`)
        this.Destroy(CloseCode.CLOSE_CLIENT_ERROR, "Connection closed erroneously.");
    }

    /*
    * Send a buffer to the client
    * */
    private async Send(encodedMessage: Buffer): Promise<void> {
        const type = BufferUtil.GetType(encodedMessage);
        const prio: "control" | "data" = (
            type === BinaryMessageType.ACK ||
            type === BinaryMessageType.PING_PONG ||
            type === BinaryMessageType.ERROR ||
            type === BinaryMessageType.TX_START ||
            type === BinaryMessageType.TX_FINISH) ? "control" : "data";

        const ok = this.bp_mgr!.enqueue(encodedMessage, prio);
        if (!ok) {
            this.log(`Frame ${BufferUtil.GetAck(encodedMessage)} was dropped by policy.`);
            return;
        }

        this.bytes_tx += encodedMessage.byteLength;
    }

    public get Client(): ws & SocketType {
        return this.remoteClient;
    }

    public get_ack_tracker(): AckTracker {
        return this.client_ack_tracker;
    }

    public get rx(): number {
        return this.bytes_rx;
    }

    public get tx(): number {
        return this.bytes_tx;
    }

    public get id(): string {
        return this.Client.sessionId;
    }

    public Destroy(code: number = 4000, message: string = "Closing session.") {
        this.bp_mgr?.Destroy();
        this.client_ack_tracker.Destroy();
        try {
            this.log(`Teardown of session. Code=${code}, reason=${message}`);
            this.Client.close(code, message);
        } catch {
            //Ignore
        }
        if (!this.destroyed)
            this.emit("closed");

        this.destroyed = true;
    }

    public Set(key: TStorageKeys, value: any): void {
        this.storage[key] = value;
    }

    public Get<T>(key: TStorageKeys): T {
        return this.storage[key] as T;
    }
}
