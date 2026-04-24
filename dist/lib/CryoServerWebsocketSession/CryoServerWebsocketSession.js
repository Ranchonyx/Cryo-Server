import { EventEmitter } from "node:events";
import { CreateDebugLogger } from "../Common/Util/CreateDebugLogger.js";
import { AckTracker } from "../Common/AckTracker/AckTracker.js";
import { BackpressureManager } from "../Common/BackpressureManager/BackpressureManager.js";
import { BufferUtil } from "../Common/Protocol/BufferUtil.js";
import { BinaryMessageType } from "../Common/Protocol/defs.js";
import { PingPongFrame } from "../Common/Protocol/Basic/PingPongFrame.js";
import { Utf8DataFrame } from "../Common/Protocol/Basic/Utf8DataFrame.js";
import { BinaryDataFrame } from "../Common/Protocol/Basic/BinaryDataFrame.js";
import { ErrorFrame } from "../Common/Protocol/Basic/ErrorFrame.js";
import { ACKFrame } from "../Common/Protocol/Basic/ACKFrame.js";
import { TXStartFrame } from "../Common/Protocol/Transaction/TXStartFrame.js";
import { TXFinishFrame } from "../Common/Protocol/Transaction/TXFinishFrame.js";
import { TXChunkFrame } from "../Common/Protocol/Transaction/TXChunkFrame.js";
var CloseCode;
(function (CloseCode) {
    CloseCode[CloseCode["CLOSE_GRACEFUL"] = 4000] = "CLOSE_GRACEFUL";
    CloseCode[CloseCode["CLOSE_CLIENT_ERROR"] = 4001] = "CLOSE_CLIENT_ERROR";
    CloseCode[CloseCode["CLOSE_SERVER_ERROR"] = 4002] = "CLOSE_SERVER_ERROR";
})(CloseCode || (CloseCode = {}));
export class CryoServerWebsocketSession extends EventEmitter {
    remoteClient;
    remoteSocket;
    remoteName;
    extensionRegistry;
    client_ack_tracker = new AckTracker();
    bp_mgr = null;
    current_ack = 0;
    current_txid = 0;
    bytes_rx = 0;
    bytes_tx = 0;
    destroyed = false;
    log;
    storage = {};
    constructor(remoteClient, remoteSocket, remoteName, backpressure_opts, extensionRegistry) {
        super();
        this.remoteClient = remoteClient;
        this.remoteSocket = remoteSocket;
        this.remoteName = remoteName;
        this.extensionRegistry = extensionRegistry;
        this.log = CreateDebugLogger(`CRYO_SERVER_SESSION`);
        this.bp_mgr = new BackpressureManager(remoteClient, backpressure_opts.highWaterMark, backpressure_opts.lowWaterMark, backpressure_opts.maxQueuedBytes, backpressure_opts.maxQueueCount, backpressure_opts.dropPolicy, CreateDebugLogger(`CRYO_BACKPRESSURE`));
        remoteSocket.once("end", this.TCPSOCKET_HandleRemoteEnd.bind(this));
        remoteSocket.once("error", this.TCPSOCKET_HandleRemoteError.bind(this));
        remoteClient.on("close", this.WEBSOCKET_HandleRemoteClose.bind(this));
        remoteClient.on("message", async (raw) => {
            this.bytes_rx += raw.byteLength;
            this.routeFrame(raw).catch((err) => {
                this.log(`routeFrame failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
            });
        });
    }
    async routeFrame(frame) {
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
    inc_get_ack() {
        if (this.current_ack + 1 > 0xffffffff)
            this.current_ack = 0;
        return this.current_ack++;
    }
    inc_get_txid() {
        if (this.current_txid + 1 > 0xffffffff)
            this.current_txid = 0;
        return this.current_txid++;
    }
    /*
    * Sends a PING frame to the client
    * */
    async Ping() {
        const new_ack_id = this.inc_get_ack();
        const encodedPingMessage = PingPongFrame
            .Serialize(this.Client.sessionId, new_ack_id, "ping");
        await this.Send(encodedPingMessage);
    }
    /*
    * Send an UTF8 string to the client
    * */
    //noinspection JSUnusedGlobalSymbols
    async SendUTF8(message) {
        const new_ack_id = this.inc_get_ack();
        const boxed_message = { value: message };
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
    async SendBinary(message) {
        const new_ack_id = this.inc_get_ack();
        const boxed_message = { value: message };
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
    async Stream(source) {
        return new Promise((resolve, reject) => {
            const new_ack_id = this.inc_get_ack();
            const new_txid = this.inc_get_txid();
            const start_frame = TXStartFrame.Serialize(this.Client.sessionId, new_ack_id, new_txid);
            this.Send(start_frame);
            source.on("data", (chunk) => {
                const chunk_frame = TXChunkFrame.Serialize(this.Client.sessionId, new_txid, chunk);
                this.Send(chunk_frame);
            });
            source.on("end", () => {
                const finish_frame = TXFinishFrame.Serialize(this.Client.sessionId, this.inc_get_ack(), new_txid);
                this.Send(finish_frame);
                resolve();
            });
            source.on("error", (err) => {
                reject(err);
            });
        });
    }
    /*
    * Respond to PING & PONG frames and set the client to be alive
    * */
    async HandlePingPongMessage(message) {
        const decodedPingPongMessage = PingPongFrame
            .Deserialize(message);
        //A peer is pinging us, play nice and respond
        if (decodedPingPongMessage.payload === "ping") {
            const outgoingPong = PingPongFrame.Serialize(this.Client.sessionId, decodedPingPongMessage.ack, "pong");
            await this.Send(outgoingPong);
        }
        else {
            //A normal client responded to our ping
            this.Client.isAlive = true;
        }
    }
    /*
    * Handling of binary error messages from the client, currently just log it
    * */
    async HandleErrorMessage(message) {
        const decodedErrorMessage = ErrorFrame
            .Deserialize(message);
        this.log(decodedErrorMessage.payload);
    }
    /*
    * Handle ACK messages from the client
    * */
    async HandleAckMessage(message) {
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
    async HandleUTF8DataMessage(message) {
        const decodedDataMessage = Utf8DataFrame
            .Deserialize(message);
        const ack_id = decodedDataMessage.ack;
        const encodedACKMessage = ACKFrame
            .Serialize(this.Client.sessionId, ack_id);
        await this.Send(encodedACKMessage);
        const boxed_message = { value: decodedDataMessage.payload };
        const result = await this.extensionRegistry
            .get_executor(this)
            .apply_after_receive(boxed_message);
        if (result.should_emit)
            this.emit("message-utf8", boxed_message.value);
    }
    /*
    * Handle DATA messages from the client
    * */
    async HandleBinaryDataMessage(message) {
        const decodedDataMessage = BinaryDataFrame
            .Deserialize(message);
        const ack_id = decodedDataMessage.ack;
        const encodedACKMessage = ACKFrame
            .Serialize(this.Client.sessionId, ack_id);
        await this.Send(encodedACKMessage);
        const boxed_message = { value: decodedDataMessage.payload };
        const result = await this.extensionRegistry
            .get_executor(this)
            .apply_after_receive(boxed_message);
        if (result.should_emit)
            this.emit("message-binary", boxed_message.value);
    }
    async HandleTxStartMessage(message) {
        const decodedStartFrame = TXStartFrame
            .Deserialize(message);
        const ack_id = decodedStartFrame.ack;
        const encodedACKMessage = ACKFrame
            .Serialize(this.Client.sessionId, ack_id);
        await this.Send(encodedACKMessage);
        this.emit("tx-start", decodedStartFrame.txId);
    }
    async HandleTxFinishMessage(message) {
        const decodedFinishFrame = TXFinishFrame
            .Deserialize(message);
        const ack_id = decodedFinishFrame.ack;
        const encodedACKMessage = ACKFrame
            .Serialize(this.Client.sessionId, ack_id);
        await this.Send(encodedACKMessage);
        this.emit("tx-finish", decodedFinishFrame.txId);
    }
    async HandleTxChunkMessage(message) {
        const decodedChunkFrame = TXChunkFrame
            .Deserialize(message);
        this.emit("tx-chunk", decodedChunkFrame.txId, decodedChunkFrame.payload);
    }
    TranslateCloseCode(code) {
        switch (code) {
            case CloseCode.CLOSE_GRACEFUL:
                return "Connection closed normally.";
            case CloseCode.CLOSE_CLIENT_ERROR:
                return "Connection closed due to a client error.";
            case CloseCode.CLOSE_SERVER_ERROR:
                return "Connection closed due to a server error.";
            default:
                return "Unspecified cause for connection closure.";
        }
    }
    WEBSOCKET_HandleRemoteClose(code, reason) {
        const code_string = this.TranslateCloseCode(code);
        this.log(`Client ${this.remoteName} has disconnected. Code=${code_string}, reason=${reason.toString("utf8")}`);
        this.Destroy(CloseCode.CLOSE_GRACEFUL, "Connection closed gracefully.");
    }
    /*
    * Log hangup and destroy session
    * */
    TCPSOCKET_HandleRemoteEnd() {
        this.log(`TCP Peer '${this.remoteName}' connection closed cleanly by client session.`);
        this.Destroy(CloseCode.CLOSE_GRACEFUL, "Connection closed gracefully.");
    }
    /*
    * Log error and destroy session
    * */
    TCPSOCKET_HandleRemoteError(err) {
        this.log(`TCP Peer '${this.remoteName}' threw an error '${err.message}' (${err?.code})`);
        this.Destroy(CloseCode.CLOSE_CLIENT_ERROR, "Connection closed erroneously.");
    }
    /*
    * Send a buffer to the client
    * */
    async Send(encodedMessage) {
        const type = BufferUtil.GetType(encodedMessage);
        const prio = (type === BinaryMessageType.ACK ||
            type === BinaryMessageType.PING_PONG ||
            type === BinaryMessageType.ERROR ||
            type === BinaryMessageType.TX_START ||
            type === BinaryMessageType.TX_FINISH) ? "control" : "data";
        const ok = this.bp_mgr.enqueue(encodedMessage, prio);
        if (!ok) {
            this.log(`Frame ${BufferUtil.GetAck(encodedMessage)} was dropped by policy.`);
            return;
        }
        this.bytes_tx += encodedMessage.byteLength;
    }
    get Client() {
        return this.remoteClient;
    }
    get_ack_tracker() {
        return this.client_ack_tracker;
    }
    get rx() {
        return this.bytes_rx;
    }
    get tx() {
        return this.bytes_tx;
    }
    get id() {
        return this.Client.sessionId;
    }
    Destroy(code = 4000, message = "Closing session.") {
        this.bp_mgr?.Destroy();
        this.client_ack_tracker.Destroy();
        try {
            this.log(`Teardown of session. Code=${code}, reason=${message}`);
            this.Client.close(code, message);
        }
        catch {
            //Ignore
        }
        if (!this.destroyed)
            this.emit("closed");
        this.destroyed = true;
    }
    Set(key, value) {
        this.storage[key] = value;
    }
    Get(key) {
        return this.storage[key];
    }
}
