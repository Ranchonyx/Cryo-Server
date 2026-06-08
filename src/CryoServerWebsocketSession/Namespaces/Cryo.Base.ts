import {
    ACKFrame, BinaryDataFrame,
    BinaryMessageType,
    BufferUtil,
    ByeFrame,
    CRYO_PROTOCOL_VERSION,
    EndpointInfoFrame, ErrorFrame, PingPongFrame, Utf8DataFrame
} from "cryo-protocol";
import {EventEmitter} from "node:events";
import {CryoExtensionExecutor} from "../../CryoExtension/CryoExtensionRegistry.js";
import {AckTracker} from "../../Common/AckTracker/AckTracker.js";

interface CryoBaseManagerEvents {
    "ready": () => void;
    "message-utf8": (message: string) => void;
    "message-binary": (message: Buffer) => void;
    "message-error": (message: string) => void;
}

export interface CryoBaseManager {
    on<U extends keyof CryoBaseManagerEvents>(event: U, listener: CryoBaseManagerEvents[U]): this;

    emit<U extends keyof CryoBaseManagerEvents>(event: U, ...args: Parameters<CryoBaseManagerEvents[U]>): boolean;
}

export class CryoBaseManager extends EventEmitter implements CryoBaseManager {
    public constructor(
        private sid: bigint,
        private send: (frame: Buffer, payload?: string | Buffer) => Promise<void>,
        private next_ack: () => number,
        private destroy: (code?: number, message?: string) => void,
        private set_features: (features: bigint) => void,
        private extension_executor: CryoExtensionExecutor,
        private client_ack_tracker: AckTracker,
        private set_session_alive: () => void
    ) {
        super();
    }

    /**
     * Send a ping to the client
     * */
    public async Ping(): Promise<void> {
        const encodedPingMessage = PingPongFrame
            .Serialize(this.sid, this.next_ack(), "ping");

        await this.send(encodedPingMessage);
    }

    /**
     * Send a UTF8 message to the client
     * */
    public async SendUTF8(message: string): Promise<void> {
        const boxed_message = {value: message};

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
    public async SendBinary(message: Buffer): Promise<void> {
        const boxed_message = {value: message};

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
    public async SendError(message: string): Promise<void> {
        const boxed_message = {value: message};
        const result = await this.extension_executor
            .apply_after_receive(boxed_message);

        if (!result.should_emit)
            return;

        const encodedErrorMessage = ErrorFrame.Serialize(this.sid, this.next_ack(), boxed_message.value);

        await this.send(encodedErrorMessage, boxed_message.value);
    }

    public async handle(frame: Buffer) {
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

    private async HandleBye(frame: Buffer): Promise<void> {
        const decodedByeMessage = ByeFrame
            .Deserialize(frame);

        await this.acknowledge(decodedByeMessage.ack);

        this.destroy(4000, decodedByeMessage.reason);
    }

    private async HandleEndpointInfo(frame: Buffer): Promise<void> {
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

    private async HandlePingPong(frame: Buffer): Promise<void> {
        const decodedPingPongMessage = PingPongFrame
            .Deserialize(frame);

        //A peer is pinging us, play nice and respond
        if (decodedPingPongMessage.payload === "ping") {
            const outgoingPong = PingPongFrame.Serialize(this.sid, decodedPingPongMessage.ack, "pong");
            await this.send(outgoingPong);
        } else {
            //A normal client responded to our ping
            this.set_session_alive();
        }
    }

    private async HandleError(frame: Buffer): Promise<void> {
        const decodedErrorMessage = ErrorFrame
            .Deserialize(frame);

        const boxed_message = {value: decodedErrorMessage.payload};
        const result = await this.extension_executor
            .apply_after_receive(boxed_message);

        await this.acknowledge(decodedErrorMessage.ack);

        if (result.should_emit)
            this.emit("message-error", boxed_message.value);
    }

    private async HandleAck(frame: Buffer): Promise<void> {
        const decodedAckMessage = ACKFrame
            .Deserialize(frame);

        const {ack} = decodedAckMessage;
        const found_message = this.client_ack_tracker.Confirm(ack);

        if (!found_message) {
            return;
        }

        found_message.ackPromise?.resolve();
    }

    private async HandleUtf8Data(frame: Buffer): Promise<void> {
        const decodedDataMessage = Utf8DataFrame
            .Deserialize(frame);

        const boxed_message = {value: decodedDataMessage.payload};
        const result = await this.extension_executor
            .apply_after_receive(boxed_message);

        await this.acknowledge(decodedDataMessage.ack);

        if (result.should_emit)
            this.emit("message-utf8", boxed_message.value);
    }

    private async HandleBinaryData(frame: Buffer): Promise<void> {
        const decodedDataMessage = BinaryDataFrame
            .Deserialize(frame);

        const boxed_message = {value: decodedDataMessage.payload};
        const result = await this.extension_executor
            .apply_after_receive(boxed_message);

        await this.acknowledge(decodedDataMessage.ack);

        if (result.should_emit)
            this.emit("message-binary", boxed_message.value);
    }

    private async acknowledge(ack_id: number) {
        const encodedACKMessage = ACKFrame
            .Serialize(this.sid, ack_id);

        await this.send(encodedACKMessage);
    }
}