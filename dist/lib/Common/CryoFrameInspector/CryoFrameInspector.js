import CryoBinaryFrameFormatter from "../CryoBinaryMessage/CryoFrameFormatter.js";
const typeToStringMap = {
    0: "utf8data",
    1: "ack",
    2: "ping/pong",
    3: "error",
    4: "binarydata",
    5: "kexchg"
};
export class CryoFrameInspector {
    static Inspect(message, encoding = "utf8") {
        const sid = CryoBinaryFrameFormatter.GetSid(message);
        const ack = CryoBinaryFrameFormatter.GetAck(message);
        const type = CryoBinaryFrameFormatter.GetType(message);
        const type_str = typeToStringMap[type] || "unknown";
        const payload = CryoBinaryFrameFormatter.GetPayload(message, encoding);
        return `[${sid},${ack},${type_str},[${payload}]]`;
    }
}
