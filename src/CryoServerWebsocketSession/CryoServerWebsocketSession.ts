import {EventEmitter} from "node:events";
import {DebugLoggerFunction} from "node:util";
import ws from "ws";
import {Duplex} from "node:stream";
import {ICryoServerWebsocketSessionEvents} from "./types/CryoWebsocketSession.js";
import CryoBinaryFrameFormatter from "../Common/CryoBinaryMessage/CryoFrameFormatter.js";
import CryoFrameFormatter, {BinaryMessageType} from "../Common/CryoBinaryMessage/CryoFrameFormatter.js";
import {createECDH, createHash, ECDH, UUID} from "node:crypto";
import {CreateDebugLogger} from "../Common/Util/CreateDebugLogger.js";
import {AckTracker} from "../Common/AckTracker/AckTracker.js";
import {CryoFrameInspector} from "../Common/CryoFrameInspector/CryoFrameInspector.js";
import {CryoExtensionRegistry} from "../CryoExtension/CryoExtensionRegistry.js";
import {FilledBackpressureOpts} from "../CryoWebsocketServer/types/CryoWebsocketServer.js";
import {BackpressureManager} from "../Common/BackpressureManager/BackpressureManager.js";
import Guard from "../Common/Util/Guard.js";
import {PerSessionCryptoHelper} from "../Common/CryptoHelper/CryptoHelper.js";

type SocketType = Duplex & { isAlive: boolean, sessionId: UUID };

export interface CryoServerWebsocketSession {
    on<U extends keyof ICryoServerWebsocketSessionEvents>(event: U, listener: ICryoServerWebsocketSessionEvents[U]): this;

    emit<U extends keyof ICryoServerWebsocketSessionEvents>(event: U, ...args: Parameters<ICryoServerWebsocketSessionEvents[U]>): boolean;
}

export class CryoServerWebsocketSession extends EventEmitter implements CryoServerWebsocketSession {
    private client_ack_tracker: AckTracker = new AckTracker();
    private readonly bp_mgr: BackpressureManager | null = null;
    private current_ack = 0;

    private bytes_rx = 0;
    private bytes_tx = 0;

    private readonly log: DebugLoggerFunction;

    private readonly ping_pong_formatter = CryoBinaryFrameFormatter.GetFormatter("ping_pong");
    private readonly ack_formatter = CryoBinaryFrameFormatter.GetFormatter("ack");
    private readonly error_formatter = CryoBinaryFrameFormatter.GetFormatter("error");
    private readonly utf8_formatter = CryoBinaryFrameFormatter.GetFormatter("utf8data");
    private readonly binary_formatter = CryoBinaryFrameFormatter.GetFormatter("binarydata");
    
    private readonly ecdh: ECDH = createECDH("prime256v1");
    private send_key: Buffer | null = null;
    private recv_key: Buffer | null = null;
    private l_crypto: PerSessionCryptoHelper | null = null;

    public constructor(private remoteClient: ws & SocketType, private remoteSocket: Duplex, private remoteName: string, backpressure_opts: FilledBackpressureOpts) {
        super();
        this.log = CreateDebugLogger(`CRYO_SERVER_SESSION`);

        this.bp_mgr = new BackpressureManager(remoteClient, backpressure_opts.highWaterMark, backpressure_opts.lowWaterMark, backpressure_opts.maxQueuedBytes, backpressure_opts.maxQueueCount, backpressure_opts.dropPolicy, CreateDebugLogger(`CRYO_BACKPRESSURE`));

        remoteSocket.once("end", this.HandleRemoteHangup.bind(this));
        remoteSocket.once("error", this.HandleRemoteError.bind(this));

        remoteClient.on("message", this.HandleIncomingMessage.bind(this));
    }

    private inc_get_ack(): number {
        if (this.current_ack + 1 > (2 ** 32 - 1))
            this.current_ack = 0;

        return this.current_ack++;
    }

    private async init_crypto_handshake() {
        this.ecdh.generateKeys();
        const pub_key = this.ecdh.getPublicKey();

        const frame = CryoFrameFormatter
            .GetFormatter("kexchg")
            .Serialize(this.Client.sessionId, this.inc_get_ack(), pub_key);

        await this.Send(frame, false);
        this.log("Sent server-to-client key exchange with public key.");
    }

    /*
    * Sends a PING frame to the client
    * */
    public async Ping(): Promise<void> {
        const new_ack_id = this.inc_get_ack();

        const encodedPingMessage = this.ping_pong_formatter
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
    public async SendBinary(message: Buffer): Promise<void> {
        const new_ack_id = this.inc_get_ack();
        const boxed_message = {value: message};

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
    private async HandlePingPongMessage(message: Buffer): Promise<void> {
        const decodedPingPongMessage = this.ping_pong_formatter
            .Deserialize(message);

        if (decodedPingPongMessage.payload !== "pong")
            return;

        this.Client.isAlive = true;
    }

    /*
    * Handling of binary error messages from the client, currently just log it
    * */
    private async HandleErrorMessage(message: Buffer): Promise<void> {
        const decodedErrorMessage = this.error_formatter
            .Deserialize(message);

        this.log(decodedErrorMessage.payload);
    }

    /*
    * Handle ACK messages from the client
    * */
    private async HandleAckMessage(message: Buffer): Promise<void> {
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
    private async HandleUTF8DataMessage(message: Buffer): Promise<void> {
        const decodedDataMessage = this.utf8_formatter
            .Deserialize(message);

        const ack_id = decodedDataMessage.ack;
        const encodedACKMessage = this.ack_formatter
            .Serialize(this.Client.sessionId, ack_id);

        await this.Send(encodedACKMessage);

        const boxed_message = {value: decodedDataMessage.payload};
        const should_emit = await CryoExtensionRegistry
            .get_executor(this)
            .apply_after_receive(boxed_message);

        if (should_emit)
            this.emit("message-utf8", boxed_message.value);
    }

    /*
    * Handle DATA messages from the client
    * */
    private async HandleBinaryDataMessage(message: Buffer): Promise<void> {
        const decodedDataMessage = this.binary_formatter
            .Deserialize(message);

        const ack_id = decodedDataMessage.ack;
        const encodedACKMessage = this.ack_formatter
            .Serialize(this.Client.sessionId, ack_id);

        await this.Send(encodedACKMessage);

        const boxed_message = {value: decodedDataMessage.payload};
        const should_emit = await CryoExtensionRegistry
            .get_executor(this)
            .apply_after_receive(boxed_message);

        if (should_emit)
            this.emit("message-binary", boxed_message.value);
    }

    private async HandleKeyExchangeMessage(message: Buffer): Promise<void> {
        const decoded = CryoFrameFormatter
            .GetFormatter("kexchg")
            .Deserialize(message);

        const client_pub_key = decoded.payload;
        const secret = this.ecdh.computeSecret(client_pub_key);

        //Make two aes128 hashes from the secret
        const hash = createHash("sha256")
            .update(secret)
            .digest();

        this.send_key = hash.subarray(0, 16);
        this.recv_key = hash.subarray(16, 32);

        const encodedACKMessage = this.ack_formatter
            .Serialize(this.Client.sessionId, decoded.ack);
        await this.Send(encodedACKMessage);

        this.l_crypto = new PerSessionCryptoHelper(this.send_key, this.recv_key);
    }

    /*
    * Handle all incoming messages
    * */
    private async HandleIncomingMessage(incoming_message: Buffer): Promise<void> {
        const message = this.secure ? this.l_crypto!.decrypt(incoming_message) : incoming_message;

        const message_type = CryoBinaryFrameFormatter.GetType(message);
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
            default:
                throw new Error(`Unsupported binary message type ${message_type}!`);
        }
    }

    /*
    * Log hangup and destroy session
    * */
    private HandleRemoteHangup() {
        this.log(`Socket ${this.remoteName} has hung up.`);
        this.Destroy();

        this.emit("closed");
    }

    /*
    * Log error and destroy session
    * */
    private HandleRemoteError(err: Error) {
        this.log(`Socket ${this.Client.sessionId} was closed due to a connection error. Code '${(err as Error & {
            code: string
        }).code}`);
        this.Destroy();
    }

    /*
    * Send a buffer to the client
    * */
    private async Send(encodedMessage: Buffer, encrypt: boolean = false): Promise<void> {
        /*
                if (!this.remoteSocket.writable && !this.remoteClient.writable) {
                    this.log("The socket being written to is not writable!");
                    return;
                }
        */
        const type = CryoBinaryFrameFormatter.GetType(encodedMessage);
        const prio: "control" | "data" = (type === BinaryMessageType.ACK || type === BinaryMessageType.PING_PONG || type === BinaryMessageType.ERROR) ? "control" : "data";
        this.log(`Sent ${CryoFrameInspector.Inspect(encodedMessage)} to client.`);

        return new Promise<void>((resolve) => {
            Guard.AgainstNullish(this.bp_mgr);
            Guard.AgainstNullish(this.l_crypto);

            const outgoing_message = this.secure ? this.l_crypto.encrypt(encodedMessage) : encodedMessage;

            const result = this.bp_mgr!.enqueue(outgoing_message, prio);
            if (!result)
                this.log(`Frame ${CryoBinaryFrameFormatter.GetAck(encodedMessage)} was dropped by policy.`);

            this.bytes_tx += encodedMessage.byteLength;
            resolve();
        });
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

    public get secure(): boolean {
        return this.l_crypto !== null;
    }

    public Destroy() {
        this.bp_mgr?.Destroy();
        this.client_ack_tracker.Destroy();
        this.Client.close(1000, "Closing session.");
        this.emit("closed");
    }
}
