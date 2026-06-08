import { ACKFrame, BinaryDataFrame, BinaryMessageType, BufferUtil, ByeFrame, CRYO_PROTOCOL_VERSION, EndpointInfoFrame, ErrorFrame, PingPongFrame, Utf8DataFrame } from "cryo-protocol";
import { EventEmitter } from "node:events";
export class CryoBaseManager extends EventEmitter {
    sid;
    send;
    next_ack;
    destroy;
    set_features;
    extension_executor;
    client_ack_tracker;
    set_session_alive;
    constructor(sid, send, next_ack, destroy, set_features, extension_executor, client_ack_tracker, set_session_alive) {
        super();
        this.sid = sid;
        this.send = send;
        this.next_ack = next_ack;
        this.destroy = destroy;
        this.set_features = set_features;
        this.extension_executor = extension_executor;
        this.client_ack_tracker = client_ack_tracker;
        this.set_session_alive = set_session_alive;
    }
    /**
     * Send a ping to the client
     * */
    async Ping() {
        const encodedPingMessage = PingPongFrame
            .Serialize(this.sid, this.next_ack(), "ping");
        await this.send(encodedPingMessage);
    }
    /**
     * Send a UTF8 message to the client
     * */
    async SendUTF8(message) {
        const boxed_message = { value: message };
        const result = await this.extension_executor
            .apply_before_send(boxed_message);
        if (!result.should_emit)
            return;
        const encodedUtf8DataMessage = Utf8DataFrame
            .Serialize(this.sid, this.next_ack(), boxed_message.value);
        await this.send(encodedUtf8DataMessage, boxed_message.value);
    }
    /**
     * Send a binary Message to the client
     * */
    async SendBinary(message) {
        const boxed_message = { value: message };
        const result = await this.extension_executor
            .apply_before_send(boxed_message);
        if (!result.should_emit)
            return;
        const encodedBinaryDataMessage = BinaryDataFrame
            .Serialize(this.sid, this.next_ack(), boxed_message.value);
        await this.send(encodedBinaryDataMessage, boxed_message.value);
    }
    /**
     * Send an error message to the client
     * */
    async SendError(message) {
        const boxed_message = { value: message };
        const result = await this.extension_executor
            .apply_after_receive(boxed_message);
        if (!result.should_emit)
            return;
        const encodedErrorMessage = ErrorFrame.Serialize(this.sid, this.next_ack(), boxed_message.value);
        await this.send(encodedErrorMessage, boxed_message.value);
    }
    async handle(frame) {
        const type = BufferUtil.GetType(frame);
        switch (type) {
            case BinaryMessageType.ENDPOINT_INFO:
                await this.HandleEndpointInfo(frame);
                return;
            case BinaryMessageType.BYE:
                await this.HandleBye(frame);
                return;
            case BinaryMessageType.ACK:
                await this.HandleAck(frame);
                return;
            case BinaryMessageType.ERROR:
                await this.HandleError(frame);
                return;
            case BinaryMessageType.PING_PONG:
                await this.HandlePingPong(frame);
                return;
            case BinaryMessageType.UTF8DATA:
                await this.HandleUtf8Data(frame);
                return;
            case BinaryMessageType.BINARYDATA:
                await this.HandleBinaryData(frame);
                return;
        }
    }
    async HandleBye(frame) {
        const decodedByeMessage = ByeFrame
            .Deserialize(frame);
        await this.acknowledge(decodedByeMessage.ack);
        this.destroy(4000, decodedByeMessage.reason);
    }
    async HandleEndpointInfo(frame) {
        const decodedInfoMessage = EndpointInfoFrame
            .Deserialize(frame);
        //Check protocol version equality and fail otherwise
        if (CRYO_PROTOCOL_VERSION !== decodedInfoMessage.version) {
            this.destroy(4001, `Protocol mismatch. Client offered ${decodedInfoMessage.version}, we support ${CRYO_PROTOCOL_VERSION} !`);
            return;
        }
        await this.acknowledge(decodedInfoMessage.ack);
        this.set_features(decodedInfoMessage.features);
        this.emit("ready");
    }
    async HandlePingPong(frame) {
        const decodedPingPongMessage = PingPongFrame
            .Deserialize(frame);
        //A peer is pinging us, play nice and respond
        if (decodedPingPongMessage.payload === "ping") {
            const outgoingPong = PingPongFrame.Serialize(this.sid, decodedPingPongMessage.ack, "pong");
            await this.send(outgoingPong);
        }
        else {
            //A normal client responded to our ping
            this.set_session_alive();
        }
    }
    async HandleError(frame) {
        const decodedErrorMessage = ErrorFrame
            .Deserialize(frame);
        const boxed_message = { value: decodedErrorMessage.payload };
        const result = await this.extension_executor
            .apply_after_receive(boxed_message);
        await this.acknowledge(decodedErrorMessage.ack);
        if (result.should_emit)
            this.emit("message-error", boxed_message.value);
    }
    async HandleAck(frame) {
        const decodedAckMessage = ACKFrame
            .Deserialize(frame);
        const { ack } = decodedAckMessage;
        const found_message = this.client_ack_tracker.Confirm(ack);
        if (!found_message) {
            return;
        }
        found_message.ackPromise?.resolve();
    }
    async HandleUtf8Data(frame) {
        const decodedDataMessage = Utf8DataFrame
            .Deserialize(frame);
        const boxed_message = { value: decodedDataMessage.payload };
        const result = await this.extension_executor
            .apply_after_receive(boxed_message);
        await this.acknowledge(decodedDataMessage.ack);
        if (result.should_emit)
            this.emit("message-utf8", boxed_message.value);
    }
    async HandleBinaryData(frame) {
        const decodedDataMessage = BinaryDataFrame
            .Deserialize(frame);
        const boxed_message = { value: decodedDataMessage.payload };
        const result = await this.extension_executor
            .apply_after_receive(boxed_message);
        await this.acknowledge(decodedDataMessage.ack);
        if (result.should_emit)
            this.emit("message-binary", boxed_message.value);
    }
    async acknowledge(ack_id) {
        const encodedACKMessage = ACKFrame
            .Serialize(this.sid, ack_id);
        await this.send(encodedACKMessage);
    }
}
