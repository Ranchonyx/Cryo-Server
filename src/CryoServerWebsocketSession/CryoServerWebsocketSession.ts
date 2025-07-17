import {EventEmitter} from "node:events";
import {DebugLoggerFunction} from "node:util";
import ws from "ws";
import {Duplex} from "node:stream";
import http from "node:http";
import {ICryoServerWebsocketSessionEvents} from "./types/CryoWebsocketSession.js";
import CryoBinaryMessageFormatterFactory, {
    BinaryMessageType
} from "../Common/CryoBinaryMessage/CryoBinaryMessageFormatterFactory.js";
import {UUID} from "node:crypto";
import {CreateDebugLogger} from "../Common/Util/CreateDebugLogger.js";
import {AckTracker} from "../Common/AckTracker/AckTracker.js";
import {CryoFrameInspector} from "../Common/CryoFrameInspector/CryoFrameInspector.js";

type SocketType = Duplex & { isAlive: boolean, sessionId: UUID };

export interface CryoServerWebsocketSession {
    on<U extends keyof ICryoServerWebsocketSessionEvents>(event: U, listener: ICryoServerWebsocketSessionEvents[U]): this;

    emit<U extends keyof ICryoServerWebsocketSessionEvents>(event: U, ...args: Parameters<ICryoServerWebsocketSessionEvents[U]>): boolean;
}

export class CryoServerWebsocketSession extends EventEmitter implements CryoServerWebsocketSession {
    private client_ack_tracker: AckTracker = new AckTracker();
    private current_ack = 0;

    private readonly log: DebugLoggerFunction;

    public constructor(private authToken: string, private remoteClient: ws & SocketType, private remoteSocket: Duplex, private initialMessage: http.IncomingMessage, private remoteName: string) {
        super();
        this.log = CreateDebugLogger(`CRYO_SERVER_SESSION`);

        remoteSocket.once("end", this.HandleRemoteHangup.bind(this));

        remoteSocket.once("error", this.HandleRemoteError.bind(this));

        remoteClient.on("message", this.HandleIncomingMessage.bind(this));
    }

    /*
    * Sends a PING frame to the client
    * */
    public async Ping(): Promise<void> {
        const new_ack_id = this.current_ack++;

        const encodedPingMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("ping_pong")
            .Serialize(this.Client.sessionId, new_ack_id, "ping");

        await this.Send(encodedPingMessage);
    }

    /*
    * Send an UTF8 string to the client
    * */
    public async SendUTF8(message: string): Promise<void> {
        const new_ack_id = this.current_ack++;

        const encodedUtf8DataMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("utf8data")
            .Serialize(this.Client.sessionId, new_ack_id, message);

        this.client_ack_tracker.Track(new_ack_id, {
            message: encodedUtf8DataMessage,
            timestamp: Date.now(),
            payload: message
        });

        await this.Send(encodedUtf8DataMessage);
    }

    /*
    * Send a binary message to the client
    * */
    public async SendBinary(message: Buffer): Promise<void> {
        const new_ack_id = this.current_ack++;

        const encodedBinaryDataMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("binarydata")
            .Serialize(this.Client.sessionId, new_ack_id, message);

        this.client_ack_tracker.Track(new_ack_id, {
            message: encodedBinaryDataMessage,
            timestamp: Date.now(),
            payload: message
        });

        await this.Send(encodedBinaryDataMessage);
    }

    /*
    * Respond to PONG frames and set the client to be alive
    * */
    private async HandlePingPongMessage(message: Buffer): Promise<void> {
        const decodedPingPongMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("ping_pong")
            .Deserialize(message);

        if (decodedPingPongMessage.payload !== "pong")
            return;

        this.Client.isAlive = true;
    }

    /*
    * Handling of binary error messages from the client, currently just log it
    * */
    private async HandleErrorMessage(message: Buffer): Promise<void> {
        const decodedErrorMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("error")
            .Deserialize(message);

        this.log(decodedErrorMessage.payload);
    }

    /*
    * Handle ACK messages from the client
    * */
    private async HandleAckMessage(message: Buffer): Promise<void> {
        const decodedAckMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("ack")
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
        const decodedDataMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("utf8data")
            .Deserialize(message);

        const ack_id = decodedDataMessage.ack;
        const encodedACKMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("ack")
            .Serialize(this.Client.sessionId, ack_id);

        await this.Send(encodedACKMessage);

        this.emit("message-utf8", decodedDataMessage.payload);
    }

    /*
    * Handle DATA messages from the client
    * */
    private async HandleBinaryDataMessage(message: Buffer): Promise<void> {
        const decodedDataMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("binarydata")
            .Deserialize(message);

        const ack_id = decodedDataMessage.ack;
        const encodedACKMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("ack")
            .Serialize(this.Client.sessionId, ack_id);

        await this.Send(encodedACKMessage);

        this.emit("message-binary", decodedDataMessage.payload);
    }

    /*
    * Handle all incoming messages
    * */
    private async HandleIncomingMessage(message: Buffer): Promise<void> {
        const message_type = CryoBinaryMessageFormatterFactory.GetType(message);
        this.log(`Received ${CryoFrameInspector.Inspect(message)} from client.`);
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
    private async Send(encodedMessage: Buffer) {
        if (!this.remoteSocket.writable && !this.remoteClient.writable) {
            this.log("The socket being written to is not writable!");
            return;
        }

        this.log(`Sent ${CryoFrameInspector.Inspect(encodedMessage)} to client.`)

        return new Promise<void>((resolve, reject) => {
            this.remoteClient.send(encodedMessage, {binary: true}, (err ?: Error) => {
                    if (err)
                        reject(err);

                    resolve();
                }
            );
        })
    }

    public get Client(): ws & SocketType {
        return this.remoteClient;
    }

    /*
        public get InitialRequest(): http.IncomingMessage {
            return this.initialMessage;
        }
    */

    public Destroy() {
        this.Client.close(1000, "Closing session.");
        this.emit("closed");
    }
}
