import { EventEmitter } from "node:events";
import CryoBinaryMessageFormatterFactory, { BinaryMessageType } from "../../Common/CryoBinaryMessage/CryoBinaryMessageFormatterFactory.js";
import { CreateDebugLogger } from "../../Common/Util/CreateDebugLogger.js";
import { AckTracker } from "../../Common/AckTracker/AckTracker.js";
import { CryoFrameInspector } from "../../Common/CryoFrameInspector/CryoFrameInspector.js";
export class CryoServerWebsocketSession extends EventEmitter {
    authToken;
    remoteClient;
    remoteSocket;
    initialMessage;
    remoteName;
    client_ack_tracker = new AckTracker();
    current_ack = 0;
    log;
    constructor(authToken, remoteClient, remoteSocket, initialMessage, remoteName) {
        super();
        this.authToken = authToken;
        this.remoteClient = remoteClient;
        this.remoteSocket = remoteSocket;
        this.initialMessage = initialMessage;
        this.remoteName = remoteName;
        this.log = CreateDebugLogger(`CRYO_SERVER_SESSION`);
        remoteSocket.once("end", this.HandleRemoteHangup.bind(this));
        remoteSocket.once("error", this.HandleRemoteError.bind(this));
        remoteClient.on("message", this.HandleIncomingMessage.bind(this));
    }
    /*
    * Sends a PING frame to the client
    * */
    async SendPing() {
        const new_ack_id = this.current_ack++;
        const encodedPingMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("ping_pong")
            .Serialize(this.Client.sessionId, new_ack_id, "ping");
        await this.Send(encodedPingMessage);
    }
    /*
    * Send an UTF8 string to the client
    * */
    async SendUTF8(message) {
        const new_ack_id = this.current_ack++;
        const encodedDataMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("data")
            .Serialize(this.Client.sessionId, new_ack_id, message);
        this.client_ack_tracker.Track(new_ack_id, {
            message: encodedDataMessage,
            timestamp: Date.now(),
            payload: message
        });
        await this.Send(encodedDataMessage);
    }
    /*
    * Respond to PONG frames and set the client to be alive
    * */
    async HandlePingPongMessage(message) {
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
    async HandleErrorMessage(message) {
        const decodedErrorMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("error")
            .Deserialize(message);
        this.log(decodedErrorMessage.payload);
    }
    /*
    * Handle ACK messages from the client
    * */
    async HandleAckMessage(message) {
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
    async HandleDataMessage(message) {
        const decodedDataMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("data")
            .Deserialize(message);
        const ack_id = decodedDataMessage.ack;
        const encodedACKMessage = CryoBinaryMessageFormatterFactory
            .GetFormatter("ack")
            .Serialize(this.Client.sessionId, ack_id);
        await this.Send(encodedACKMessage);
        this.emit("message", decodedDataMessage.payload);
    }
    /*
    * Handle all incoming messages
    * */
    async HandleIncomingMessage(message) {
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
            case BinaryMessageType.DATA:
                await this.HandleDataMessage(message);
                return;
            default:
                throw new Error(`Unsupported binary message type ${message_type}!`);
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
    async Send(encodedMessage) {
        if (!this.remoteSocket.writable && !this.remoteClient.writable) {
            this.log("The socket being written to is not writable!");
            return;
        }
        this.log(`Sent ${CryoFrameInspector.Inspect(encodedMessage)} to client.`);
        return new Promise((resolve, reject) => {
            this.remoteClient.send(encodedMessage, { binary: true }, (err) => {
                if (err)
                    reject(err);
                resolve();
            });
        });
    }
    get Client() {
        return this.remoteClient;
    }
    /*
        public get InitialRequest(): http.IncomingMessage {
            return this.initialMessage;
        }
    */
    Destroy() {
        this.Client.close(1000, "Closing session.");
        this.emit("closed");
    }
}
