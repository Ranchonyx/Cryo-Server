import CryoBinaryFrameFormatter from "../CryoBinaryMessage/CryoFrameFormatter.js";

const typeToStringMap = {
    0: "utf8data",
    1: "ack",
    2: "ping/pong",
    3: "error",
    4: "binarydata",
    5: "server_hello",
    6: "client_hello",
    7: "handshake_done",
}

export class CryoFrameInspector {
    public static Inspect(message: Buffer, encoding: BufferEncoding = "utf8"): string {
        const sid = CryoBinaryFrameFormatter.GetSid(message);
        const ack = CryoBinaryFrameFormatter.GetAck(message);
        const type = CryoBinaryFrameFormatter.GetType(message);
        const type_str = typeToStringMap[type] || "unknown";

        const payload = CryoBinaryFrameFormatter.GetPayload(message, encoding);

        return `[${sid},${ack},${type_str},[${payload}]]`
    }
}