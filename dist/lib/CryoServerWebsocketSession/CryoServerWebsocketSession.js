import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { CreateDebugLogger } from "../Common/Util/CreateDebugLogger.js";
import { AckTracker } from "../Common/AckTracker/AckTracker.js";
import { BackpressureManager } from "../BackpressureManager/BackpressureManager.js";
import { ACKFrame, BinaryDataFrame, BinaryMessageType, BufferUtil, ByeFrame, CRYO_FEATURE_MASK_TRANSACTION, CRYO_PROTOCOL_VERSION, cryoHasFeatureFlag, EndpointInfoFrame, ErrorFrame, PingPongFrame, TXChunkFrame, TXFinishFrame, TXStartFrame, Utf8DataFrame } from "cryo-protocol";
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
    bp_mgr;
    log;
    client_ack_tracker = new AckTracker();
    storage = {};
    streams = new Map;
    destroyed = false;
    current_ack = 0;
    current_txid = 0;
    bytes_rx = 0;
    bytes_tx = 0;
    receivedProtocolFeatures = 0n;
    constructor(remoteClient, remoteSocket, remoteName, backpressure_opts, extensionRegistry) {
        super();
        this.remoteClient = remoteClient;
        this.remoteSocket = remoteSocket;
        this.remoteName = remoteName;
        this.extensionRegistry = extensionRegistry;
        this.log = CreateDebugLogger(`CRYO_SERVER_SESSION`);
        this.bp_mgr = new BackpressureManager(remoteClient, backpressure_opts, CreateDebugLogger(`CRYO_BACKPRESSURE`));
        //set up listeners
        remoteSocket.once("end", this.TCPSOCKET_HandleRemoteEnd.bind(this));
        remoteSocket.once("error", this.TCPSOCKET_HandleRemoteError.bind(this));
        remoteClient.on("close", this.WEBSOCKET_HandleRemoteClose.bind(this));
        //Handle incoming ws messages
        remoteClient.on("message", async (raw) => {
            this.bytes_rx += raw.byteLength;
            this.routeFrame(raw).catch((err) => {
                this.log(`routeFrame failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
            });
        });
        //Send the first endpointInfo message
        const ack = this.inc_get_ack();
        const msg = EndpointInfoFrame.Serialize(this.sid, ack);
        this.client_ack_tracker.Track(ack, { timestamp: Date.now(), message: msg });
        this.Send(msg);
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
            case BinaryMessageType.ENDPOINT_INFO:
                await this.HandleEndpointInfoMessage(frame);
                return;
            case BinaryMessageType.BYE:
                await this.HandleByeMessage(frame);
                return;
            case BinaryMessageType.TX_FLOW:
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
    //noinspection JSUnusedGlobalSymbols
    async WaitForStream(streamName = "anonymous", timeout = 1000) {
        const timeoutSig = AbortSignal.timeout(timeout);
        return new Promise((resolve, reject) => {
            const onTxStartListener = async (txId, txName) => {
                if (txName === streamName) {
                    if (!this.streams.has(txId)) {
                        this.off("tx-start", onTxStartListener);
                        timeoutSig.removeEventListener("abort", onAbort);
                        reject(new Error(`No stream id ${txId} present!`));
                    }
                    const stream = this.streams.get(txId);
                    //Remove this listener once the stream has been read
                    stream.on("close", () => {
                        this.off("tx-start", onTxStartListener);
                    });
                    resolve(stream);
                }
            };
            const onAbort = () => {
                this.off("tx-start", onTxStartListener);
                timeoutSig.removeEventListener("abort", onAbort);
                reject(new Error(`Timeout elapsed!`));
            };
            this.on("tx-start", onTxStartListener);
            timeoutSig.addEventListener("abort", onAbort);
        });
    }
    //noinspection JSUnusedGlobalSymbols
    async Stream(source, streamName = "anonymous") {
        const new_txid = this.inc_get_txid();
        //Send tx_start
        const start_ack_id = this.inc_get_ack();
        const start_frame = TXStartFrame.Serialize(this.Client.sessionId, start_ack_id, new_txid, streamName);
        this.client_ack_tracker.Track(start_ack_id, {
            message: start_frame,
            timestamp: Date.now()
        });
        await this.Send(start_frame);
        //Send tx_chunk
        for await (const chunk of source) {
            const chunk_frame = TXChunkFrame.Serialize(this.Client.sessionId, new_txid, chunk);
            await this.Send(chunk_frame);
        }
        //send tx_finish
        const finish_ack_id = this.inc_get_ack();
        const finish_frame = TXFinishFrame.Serialize(this.Client.sessionId, finish_ack_id, new_txid);
        this.client_ack_tracker.Track(finish_ack_id, {
            message: finish_frame,
            timestamp: Date.now()
        });
        await this.Send(finish_frame);
        await this.bp_mgr.waitUntilEmpty();
    }
    async HandleByeMessage(message) {
        const decodedByeMessage = ByeFrame
            .Deserialize(message);
        const ack_id = decodedByeMessage.ack;
        const encodedACKMessage = ACKFrame
            .Serialize(this.Client.sessionId, ack_id);
        await this.Send(encodedACKMessage);
        this.Destroy(4000, decodedByeMessage.reason);
    }
    async HandleEndpointInfoMessage(message) {
        const decodedInfoMessage = EndpointInfoFrame
            .Deserialize(message);
        const ack_id = decodedInfoMessage.ack;
        const encodedACKMessage = ACKFrame
            .Serialize(this.Client.sessionId, ack_id);
        await this.Send(encodedACKMessage);
        //Check protocol version equality and fail otherwise
        if (CRYO_PROTOCOL_VERSION !== decodedInfoMessage.version) {
            this.Destroy(4001, `Protocol mismatch. Client offered ${decodedInfoMessage.version}, we support ${CRYO_PROTOCOL_VERSION} !`);
            return;
        }
        this.log("Got protocol features: ", this.receivedProtocolFeatures.toString(2).padStart(64));
        this.receivedProtocolFeatures = decodedInfoMessage.features;
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
        const ack_id = decodedErrorMessage.ack;
        const encodedACKMessage = ACKFrame
            .Serialize(this.Client.sessionId, ack_id);
        await this.Send(encodedACKMessage);
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
        if (!cryoHasFeatureFlag(this.receivedProtocolFeatures, CRYO_FEATURE_MASK_TRANSACTION)) {
            this.Destroy(4002, "PROTOCOL FEATURE MISMATCH");
            throw new Error("The connected client does not support features in the namespace 'Cryo.Transaction' !");
        }
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
    async HandleTxFinishMessage(message) {
        if (!cryoHasFeatureFlag(this.receivedProtocolFeatures, CRYO_FEATURE_MASK_TRANSACTION)) {
            this.Destroy(4002, "PROTOCOL FEATURE MISMATCH");
            throw new Error("The connected client does not support features in the namespace 'Cryo.Transaction' !");
        }
        const decodedFinishFrame = TXFinishFrame
            .Deserialize(message);
        const ack_id = decodedFinishFrame.ack;
        const encodedACKMessage = ACKFrame
            .Serialize(this.Client.sessionId, ack_id);
        await this.Send(encodedACKMessage);
        //Handle stream
        if (!this.streams.has(decodedFinishFrame.txId))
            return;
        this.streams.get(decodedFinishFrame.txId).push(null);
        this.emit("tx-finish", decodedFinishFrame.txId);
    }
    async HandleTxChunkMessage(message) {
        if (!cryoHasFeatureFlag(this.receivedProtocolFeatures, CRYO_FEATURE_MASK_TRANSACTION)) {
            this.Destroy(4002, "PROTOCOL FEATURE MISMATCH");
            throw new Error("The connected client does not support features in the namespace 'Cryo.Transaction' !");
        }
        const decodedChunkFrame = TXChunkFrame
            .Deserialize(message);
        //Handle stream
        if (!this.streams.has(decodedChunkFrame.txId))
            return;
        this.streams.get(decodedChunkFrame.txId).push(decodedChunkFrame.payload);
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
        while (true) {
            const ok = this.bp_mgr.enqueue(encodedMessage);
            if (ok) {
                this.bytes_tx += encodedMessage.byteLength;
                return;
            }
            await this.bp_mgr.spinUntilWritable();
        }
    }
    get Client() {
        return this.remoteClient;
    }
    get_ack_tracker() {
        return this.client_ack_tracker;
    }
    //noinspection JSUnusedGlobalSymbols
    get rx() {
        return this.bytes_rx;
    }
    //noinspection JSUnusedGlobalSymbols
    get tx() {
        return this.bytes_tx;
    }
    //noinspection JSUnusedGlobalSymbols
    get sid() {
        return this.Client.sessionId;
    }
    //noinspection JSUnusedGlobalSymbols
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
    //noinspection JSUnusedGlobalSymbols
    Set(key, value) {
        this.storage[key] = value;
    }
    //noinspection JSUnusedGlobalSymbols
    Get(key) {
        return this.storage[key];
    }
}
