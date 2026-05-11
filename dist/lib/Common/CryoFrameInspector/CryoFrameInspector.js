import { BinaryMessageType, BufferUtil } from "cryo-protocol";
const typeToStringMap = {
    0: "ack",
    1: "error",
    2: "ping/pong",
    3: "utf8data",
    4: "binarydata",
    5: "transaction_start",
    6: "transaction_chunk",
    7: "transaction_finish",
};
export class CryoFrameInspector {
    static Inspect(message) {
        const sid = BufferUtil.GetSid(message);
        const type = BufferUtil.GetType(message);
        const type_str = typeToStringMap[type] || "unknown";
        const ack = BufferUtil.GetAck(message);
        if (type >= BinaryMessageType.TX_START) {
            switch (type) {
                case BinaryMessageType.TX_START:
                    return `[type=${type_str}, sid=${sid},ack=${ack},txid=${BufferUtil.Transaction.GetTxId(message)},name=${BufferUtil.Transaction.GetTxName(message)}]`;
                case BinaryMessageType.TX_FINISH:
                    return `[type=${type_str}, sid=${sid},ack=${ack},txid=${BufferUtil.Transaction.GetTxId(message)}]`;
                case BinaryMessageType.TX_CHUNK:
                    return `[type=${type_str}, sid=${sid},txid=${BufferUtil.Transaction.GetChunkTxId(message)},payload[0..15]=${BufferUtil.Transaction.GetChunkPayload(message, "hex").substring(0, 0xf)}]`;
            }
            throw new Error("Unknown type " + type);
        }
        else {
            const payload = BufferUtil.GetPayload(message, "hex").substring(0, 0xf);
            return `[type=${type_str}, sid=${sid},ack=${ack},payload[0..15]=${payload}]`;
        }
    }
}
