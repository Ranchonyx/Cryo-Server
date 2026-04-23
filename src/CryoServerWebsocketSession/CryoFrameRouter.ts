import {BinaryMessageType} from "../Common/CryoBinaryMessage/CryoFrameFormatter.js";
import {DebugLoggerFunction} from "node:util";
import {CreateDebugLogger} from "../Common/Util/CreateDebugLogger.js";

interface RouterHandlers {
    //Normal frame routing
    on_ping_pong: (frame: Buffer) => Promise<void>;
    on_ack: (frame: Buffer) => Promise<void>;
    on_error: (frame: Buffer) => Promise<void>;
    on_utf8: (frame: Buffer) => Promise<void>;
    on_binary: (frame: Buffer) => Promise<void>;
}

export class CryoFrameRouter {
    public constructor(
        private readonly handlers: RouterHandlers,
        private log: DebugLoggerFunction = CreateDebugLogger("CRYO_FRAME_ROUTER")
    ) {
    }

    private try_get_type(buf: Buffer): BinaryMessageType | null {
        if (!buf || buf.length < 21)
            return null;

        return buf.readUint8(20);
    }

    public async do_route(frame: Buffer): Promise<void> {
        let type = this.try_get_type(frame);

        if (type === null) {
            this.log(`Unknown frame type`, type);
            return;
        }

        switch (type) {
            case BinaryMessageType.PING_PONG:
                await this.handlers.on_ping_pong(frame);
                return;
            case BinaryMessageType.ERROR:
                await this.handlers.on_error(frame);
                return;
            case BinaryMessageType.ACK:
                await this.handlers.on_ack(frame);
                return;
            case BinaryMessageType.UTF8DATA:
                await this.handlers.on_utf8(frame);
                return;
            case BinaryMessageType.BINARYDATA:
                await this.handlers.on_binary(frame);
                return;
            default:
                this.log(`Unsupported binary message type ${type}!`);
        }
    }
}