import { EventEmitter } from "node:events";
import CryoBinaryFrameFormatter from "../Common/CryoBinaryMessage/CryoFrameFormatter.js";
import CryoFrameFormatter, { BinaryMessageType } from "../Common/CryoBinaryMessage/CryoFrameFormatter.js";
import { CreateDebugLogger } from "../Common/Util/CreateDebugLogger.js";
import { AckTracker } from "../Common/AckTracker/AckTracker.js";
import { CryoExtensionRegistry } from "../CryoExtension/CryoExtensionRegistry.js";
import { BackpressureManager } from "../Common/BackpressureManager/BackpressureManager.js";
import { CryoCryptoBox } from "./CryoCryptoBox.js";
import { CryoHandshakeEngine, HandshakeState } from "./CryoHandshakeEngine.js";
import { CryoFrameRouter } from "./CryoFrameRouter.js";
export class CryoServerWebsocketSession extends EventEmitter {
    remoteClient;
    remoteSocket;
    remoteName;
    client_ack_tracker = new AckTracker();
    bp_mgr = null;
    current_ack = 0;
    bytes_rx = 0;
    bytes_tx = 0;
    log;
    ping_pong_formatter = CryoBinaryFrameFormatter.GetFormatter("ping_pong");
    ack_formatter = CryoBinaryFrameFormatter.GetFormatter("ack");
    error_formatter = CryoBinaryFrameFormatter.GetFormatter("error");
    utf8_formatter = CryoBinaryFrameFormatter.GetFormatter("utf8data");
    binary_formatter = CryoBinaryFrameFormatter.GetFormatter("binarydata");
    crypto = null;
    handshake;
    router;
    constructor(remoteClient, remoteSocket, remoteName, backpressure_opts) {
        super();
        this.remoteClient = remoteClient;
        this.remoteSocket = remoteSocket;
        this.remoteName = remoteName;
        this.log = CreateDebugLogger(`CRYO_SERVER_SESSION`);
        this.bp_mgr = new BackpressureManager(remoteClient, backpressure_opts.highWaterMark, backpressure_opts.lowWaterMark, backpressure_opts.maxQueuedBytes, backpressure_opts.maxQueueCount, backpressure_opts.dropPolicy, CreateDebugLogger(`CRYO_BACKPRESSURE`));
        const handshake_events = {
            onSecure: ({ transmit_key, receive_key }) => {
                this.crypto = new CryoCryptoBox(transmit_key, receive_key);
                this.log("Handshake completed. Session is now secured.");
            },
            onFailure: (reason) => {
                this.log(`Handshake failure: ${reason}`);
                this.Destroy();
            }
        };
        this.handshake = new CryoHandshakeEngine(this.Client.sessionId, (buffer) => this.Send(buffer, true), CryoFrameFormatter, () => this.inc_get_ack(), handshake_events);
        this.router = new CryoFrameRouter(CryoFrameFormatter, () => this.handshake.is_secure, (buffer) => this.crypto.decrypt(buffer), {
            on_ping_pong: async (b) => this.HandlePingPongMessage(b),
            on_ack: async (b) => this.HandleAckMessage(b),
            on_error: async (b) => this.HandleErrorMessage(b),
            on_utf8: async (b) => this.HandleUTF8DataMessage(b),
            on_binary: async (b) => this.HandleBinaryDataMessage(b),
            on_client_hello: async (b) => this.handshake.on_client_hello(b),
            on_handshake_done: async (b) => this.handshake.on_client_handshake_done(b)
        });
        remoteSocket.once("end", this.HandleRemoteHangup.bind(this));
        remoteSocket.once("error", this.HandleRemoteError.bind(this));
        remoteClient.on("message", (raw) => this.router.do_route(raw));
        this.handshake.start_server_hello();
    }
    inc_get_ack() {
        if (this.current_ack + 1 > (2 ** 32 - 1))
            this.current_ack = 0;
        return this.current_ack++;
    }
    /*
    * Sends a PING frame to the client
    * */
    async Ping() {
        const new_ack_id = this.inc_get_ack();
        const encodedPingMessage = this.ping_pong_formatter
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
        await CryoExtensionRegistry
            .get_executor(this)
            .apply_before_send(boxed_message);
        const encodedUtf8DataMessage = this.utf8_formatter
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
        await CryoExtensionRegistry
            .get_executor(this)
            .apply_before_send(boxed_message);
        const encodedBinaryDataMessage = this.binary_formatter
            .Serialize(this.Client.sessionId, new_ack_id, boxed_message.value);
        this.client_ack_tracker.Track(new_ack_id, {
            message: encodedBinaryDataMessage,
            timestamp: Date.now(),
            payload: boxed_message.value
        });
        await this.Send(encodedBinaryDataMessage);
    }
    /*
    * Respond to PONG frames and set the client to be alive
    * */
    async HandlePingPongMessage(message) {
        const decodedPingPongMessage = this.ping_pong_formatter
            .Deserialize(message);
        if (decodedPingPongMessage.payload !== "pong")
            return;
        this.Client.isAlive = true;
    }
    /*
    * Handling of binary error messages from the client, currently just log it
    * */
    async HandleErrorMessage(message) {
        const decodedErrorMessage = this.error_formatter
            .Deserialize(message);
        this.log(decodedErrorMessage.payload);
    }
    /*
    * Handle ACK messages from the client
    * */
    async HandleAckMessage(message) {
        const decodedAckMessage = this.ack_formatter
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
        const decodedDataMessage = this.utf8_formatter
            .Deserialize(message);
        const ack_id = decodedDataMessage.ack;
        const encodedACKMessage = this.ack_formatter
            .Serialize(this.Client.sessionId, ack_id);
        await this.Send(encodedACKMessage);
        const boxed_message = { value: decodedDataMessage.payload };
        const should_emit = await CryoExtensionRegistry
            .get_executor(this)
            .apply_after_receive(boxed_message);
        if (should_emit)
            this.emit("message-utf8", boxed_message.value);
    }
    /*
    * Handle DATA messages from the client
    * */
    async HandleBinaryDataMessage(message) {
        const decodedDataMessage = this.binary_formatter
            .Deserialize(message);
        const ack_id = decodedDataMessage.ack;
        const encodedACKMessage = this.ack_formatter
            .Serialize(this.Client.sessionId, ack_id);
        await this.Send(encodedACKMessage);
        const boxed_message = { value: decodedDataMessage.payload };
        const should_emit = await CryoExtensionRegistry
            .get_executor(this)
            .apply_after_receive(boxed_message);
        if (should_emit)
            this.emit("message-binary", boxed_message.value);
    }
    /*
    * Log hangup and destroy session
    * */
    HandleRemoteHangup() {
        this.log(`Socket ${this.remoteName} has hung up.`);
        this.Destroy();
        this.emit("closed");
    }
    /*
    * Log error and destroy session
    * */
    HandleRemoteError(err) {
        this.log(`Socket ${this.Client.sessionId} was closed due to a connection error. Code '${err.code}`);
        this.Destroy();
    }
    /*
    * Send a buffer to the client
    * */
    async Send(encodedMessage, plain = false) {
        const type = CryoBinaryFrameFormatter.GetType(encodedMessage);
        const prio = (type === BinaryMessageType.ACK || type === BinaryMessageType.PING_PONG || type === BinaryMessageType.ERROR) ? "control" : "data";
        const is_secure = this.handshake.state === HandshakeState.SECURE;
        const outgoing = is_secure && !plain ? this.crypto.encrypt(encodedMessage) : encodedMessage;
        const ok = this.bp_mgr.enqueue(outgoing, prio);
        if (!ok) {
            this.log(`Frame ${CryoBinaryFrameFormatter.GetAck(encodedMessage)} was dropped by policy.`);
            return;
        }
        this.bytes_tx += outgoing.byteLength;
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
    get secure() {
        return this.handshake?.state === HandshakeState.SECURE && this.crypto !== null;
    }
    Destroy() {
        this.bp_mgr?.Destroy();
        this.client_ack_tracker.Destroy();
        this.Client.close(1000, "Closing session.");
        this.emit("closed");
    }
}
