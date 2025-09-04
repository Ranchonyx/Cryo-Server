import { EventEmitter } from "node:events";
import CryoBinaryFrameFormatter from "../Common/CryoBinaryMessage/CryoFrameFormatter.js";
import CryoFrameFormatter, { BinaryMessageType } from "../Common/CryoBinaryMessage/CryoFrameFormatter.js";
import { createECDH, createHash } from "node:crypto";
import { CreateDebugLogger } from "../Common/Util/CreateDebugLogger.js";
import { AckTracker } from "../Common/AckTracker/AckTracker.js";
import { CryoFrameInspector } from "../Common/CryoFrameInspector/CryoFrameInspector.js";
import { CryoExtensionRegistry } from "../CryoExtension/CryoExtensionRegistry.js";
import { BackpressureManager } from "../Common/BackpressureManager/BackpressureManager.js";
import { PerSessionCryptoHelper } from "../Common/CryptoHelper/CryptoHelper.js";
/*
* Crypto state
* */
var CryptoState;
(function (CryptoState) {
    CryptoState[CryptoState["INITIAL"] = 0] = "INITIAL";
    CryptoState[CryptoState["WAIT_CLIENT_KEX"] = 1] = "WAIT_CLIENT_KEX";
    CryptoState[CryptoState["WAIT_SERVER_ACK"] = 2] = "WAIT_SERVER_ACK";
    CryptoState[CryptoState["SECURE"] = 3] = "SECURE"; // Both sides acknowledged, channel encrypted
})(CryptoState || (CryptoState = {}));
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
    crypt_state = CryptoState.INITIAL;
    ecdh = createECDH("prime256v1");
    l_crypto = null;
    server_kex_ack_id = null;
    constructor(remoteClient, remoteSocket, remoteName, backpressure_opts) {
        super();
        this.remoteClient = remoteClient;
        this.remoteSocket = remoteSocket;
        this.remoteName = remoteName;
        this.log = CreateDebugLogger(`CRYO_SERVER_SESSION`);
        this.bp_mgr = new BackpressureManager(remoteClient, backpressure_opts.highWaterMark, backpressure_opts.lowWaterMark, backpressure_opts.maxQueuedBytes, backpressure_opts.maxQueueCount, backpressure_opts.dropPolicy, CreateDebugLogger(`CRYO_BACKPRESSURE`));
        remoteSocket.once("end", this.HandleRemoteHangup.bind(this));
        remoteSocket.once("error", this.HandleRemoteError.bind(this));
        remoteClient.on("message", this.HandleIncomingMessage.bind(this));
        this.init_crypto_handshake();
    }
    inc_get_ack() {
        if (this.current_ack + 1 > (2 ** 32 - 1))
            this.current_ack = 0;
        return this.current_ack++;
    }
    async init_crypto_handshake() {
        this.ecdh.generateKeys();
        const pub_key = this.ecdh.getPublicKey(null, "uncompressed");
        const ack_id = this.inc_get_ack();
        this.server_kex_ack_id = ack_id;
        const frame = CryoFrameFormatter
            .GetFormatter("kexchg")
            .Serialize(this.Client.sessionId, ack_id, pub_key);
        await this.Send(frame);
        this.log("Sent server public key!");
        this.crypt_state = CryptoState.WAIT_CLIENT_KEX;
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
        if (this.crypt_state === CryptoState.WAIT_SERVER_ACK && ack_id === this.server_kex_ack_id) {
            this.crypt_state = CryptoState.SECURE;
            this.log("Handshake complete, channel secured!");
            return;
        }
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
    async HandleKeyExchangeMessage(message) {
        const decoded = CryoFrameFormatter
            .GetFormatter("kexchg")
            .Deserialize(message);
        const client_pub_key = decoded.payload;
        //Compute secret
        const secret = this.ecdh.computeSecret(client_pub_key);
        const hash = createHash("sha256")
            .update(secret)
            .digest();
        //Server sends with first half, receives with second half (opposite of client)
        const send_key = hash.subarray(0, 16);
        const recv_key = hash.subarray(16, 32);
        this.l_crypto = new PerSessionCryptoHelper(send_key, recv_key);
        //ACK the clients KEX in plain
        const encodedACKMessage = this.ack_formatter
            .Serialize(this.Client.sessionId, decoded.ack);
        await this.Send(encodedACKMessage, true);
        this.log("Got client pubkey and derived keys. Waiting for client ACK of our pubkey");
        this.crypt_state = CryptoState.WAIT_SERVER_ACK;
    }
    /*
    * Handle all incoming messages
    * */
    async HandleIncomingMessage(incoming_message) {
        let message;
        let message_type;
        if (this.crypt_state === CryptoState.INITIAL || this.crypt_state === CryptoState.WAIT_CLIENT_KEX) {
            //Raw frame inspections
            message_type = CryoBinaryFrameFormatter.GetType(incoming_message);
            this.log(`Handshake state=${this.crypt_state}, rawType=${message_type}, ACK=${BinaryMessageType.ACK}, KEXCHG=${BinaryMessageType.KEXCHG}, buf=${incoming_message.toString("hex")}`);
            if (![BinaryMessageType.KEXCHG, BinaryMessageType.ACK].includes(message_type)) {
                this.log(`Unexpected message type ${message_type} in handshake state ${this.crypt_state}`);
                this.Destroy();
            }
            message = incoming_message;
        }
        else {
            //We're already secure, or rotating keys
            const decrypted = this.l_crypto.decrypt(incoming_message);
            message_type = CryoBinaryFrameFormatter.GetType(decrypted);
            message = decrypted;
        }
        this.log(`Received ${CryoFrameInspector.Inspect(message)} from client.`);
        this.bytes_rx += message.byteLength;
        switch (message_type) {
            case BinaryMessageType.PING_PONG:
                await this.HandlePingPongMessage(message);
                return;
            case BinaryMessageType.ERROR:
                await this.HandleErrorMessage(message);
                return;
            case BinaryMessageType.ACK:
                await this.HandleAckMessage(message);
                return;
            case BinaryMessageType.UTF8DATA:
                await this.HandleUTF8DataMessage(message);
                return;
            case BinaryMessageType.BINARYDATA:
                await this.HandleBinaryDataMessage(message);
                return;
            case BinaryMessageType.KEXCHG:
                await this.HandleKeyExchangeMessage(message);
                return;
            default: {
                this.log(`Unsupported binary message type ${message_type}!`);
                this.Destroy();
            }
        }
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
        /*
                if (!this.remoteSocket.writable && !this.remoteClient.writable) {
                    this.log("The socket being written to is not writable!");
                    return;
                }
        */
        const type = CryoBinaryFrameFormatter.GetType(encodedMessage);
        const prio = (type === BinaryMessageType.ACK || type === BinaryMessageType.PING_PONG || type === BinaryMessageType.ERROR) ? "control" : "data";
        const outgoing_message = (this.secure && !plain) ? this.l_crypto.encrypt(encodedMessage) : encodedMessage;
        const result = this.bp_mgr.enqueue(outgoing_message, prio);
        if (!result) {
            this.log(`Frame ${CryoBinaryFrameFormatter.GetAck(encodedMessage)} was dropped by policy.`);
            return;
        }
        this.bytes_tx += outgoing_message.byteLength;
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
        return this.l_crypto !== null;
    }
    Destroy() {
        this.bp_mgr?.Destroy();
        this.client_ack_tracker.Destroy();
        this.Client.close(1000, "Closing session.");
        this.emit("closed");
    }
}
