import { ACKFrame, BinaryMessageType, BufferUtil, CRYO_FEATURE_MASK_TRANSACTION, CRYO_FLOW_BEHAVIOUR, cryoHasFeatureFlag, TXCancelFrame, TXChunkFrame, TXFetchFrame, TXFinishFrame, TXFlowFrame, TXStartFrame } from "cryo-protocol";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
export class CryoTransactionManager extends EventEmitter {
    sid;
    send;
    next_ack;
    next_txid;
    destroy;
    get_features;
    waitUntilEmpty;
    outgoingFlowControl = CRYO_FLOW_BEHAVIOUR.TX_PUSH;
    incomingStreams = new Map();
    outgoingStreams = new Map();
    constructor(sid, send, next_ack, next_txid, destroy, get_features, waitUntilEmpty) {
        super();
        this.sid = sid;
        this.send = send;
        this.next_ack = next_ack;
        this.next_txid = next_txid;
        this.destroy = destroy;
        this.get_features = get_features;
        this.waitUntilEmpty = waitUntilEmpty;
    }
    /**
     * Stream a readable to the client
     * @param source The {@link Readable} object to be streamed
     * @param streamName Optionally, the name of the stream
     * */
    async Stream(source, streamName = "anonymous") {
        if (this.outgoingFlowControl !== CRYO_FLOW_BEHAVIOUR.TX_PUSH)
            return this.StreamPull(source, streamName);
        return this.StreamPush(source, streamName);
    }
    /**
     * Wait for an incoming stream
     * @param streamName The name of the stream to wait for - leave empty to wait for an unnamed stream
     * @param timeout The amount of milliseconds to wait until the operation should be cancelled if no matching stream was received
     * */
    async WaitForStream(streamName = "anonymous", timeout = 2500) {
        const timeoutSig = AbortSignal.timeout(timeout);
        return new Promise((resolve, reject) => {
            const onTxStartListener = async (txId, txName) => {
                if (txName === streamName) {
                    if (!this.incomingStreams.has(txId)) {
                        this.off("tx-start", onTxStartListener);
                        timeoutSig.removeEventListener("abort", onAbort);
                        reject(new Error(`No stream id ${txId} present!`));
                    }
                    const stream = this.incomingStreams.get(txId);
                    //Remove this listener once the stream has been read
                    stream.on("close", () => {
                        this.off("tx-start", onTxStartListener);
                    });
                    resolve(stream);
                }
            };
            const onAbort = () => {
                this.off("tx-start", onTxStartListener);
                timeoutSig.removeEventListener("abort", onAbort);
                reject(new Error(`Timeout elapsed!`));
            };
            this.on("tx-start", onTxStartListener);
            timeoutSig.addEventListener("abort", onAbort);
        });
    }
    /**
     * Request a range of chunks from the stream - used when flow control = TX_PULL
     * @param stream The readable object returned by {@link WaitForStream}
     * @param start The starting index of chunks to be requested
     * @param end The ending index of chunks to be requested
     * */
    async StreamRequestRange(stream, start, end) {
        const fetch_ack_id = this.next_ack();
        const fetch_frame = TXFetchFrame.Serialize(this.sid, fetch_ack_id, stream.txId, start, end);
        await this.send(fetch_frame);
    }
    /**
     * Sets the flow control for this session
     * @param behaviour The flow control behaviour to set the client to
     * */
    async SetIncomingFlowControl(behaviour) {
        const flow_frame = TXFlowFrame.Serialize(this.sid, this.next_ack(), behaviour);
        await this.send(flow_frame);
    }
    async StreamPush(source, streamName) {
        const new_txid = this.next_txid();
        const controller = new AbortController();
        const signal = controller.signal;
        this.outgoingStreams.set(new_txid, controller);
        try {
            //Send tx_start
            const start_ack_id = this.next_ack();
            const start_frame = TXStartFrame.Serialize(this.sid, start_ack_id, new_txid, streamName);
            await this.send(start_frame);
            //Send tx_chunk
            let seq = 0;
            for await (const chunk of source) {
                signal.throwIfAborted();
                const chunk_frame = TXChunkFrame.Serialize(this.sid, new_txid, seq++, chunk);
                await this.send(chunk_frame);
            }
            //send tx_finish
            const finish_ack_id = this.next_ack();
            const finish_frame = TXFinishFrame.Serialize(this.sid, finish_ack_id, new_txid);
            await this.send(finish_frame);
        }
        catch (reason) {
            //this.log(`Transaction ${new_txid} was aborted by client.`);
        }
        finally {
            this.outgoingStreams.delete(new_txid);
            await this.waitUntilEmpty();
        }
    }
    async StreamPull(source, streamName) {
        return new Promise(async (resolve, reject) => {
            const start_ack_id = this.next_ack();
            const new_txid = this.next_txid();
            const chunks = [];
            let totalSize = 0;
            let seq = 0;
            const controller = new AbortController();
            const signal = controller.signal;
            this.outgoingStreams.set(new_txid, controller);
            try {
                for await (const chunk of source) {
                    signal.throwIfAborted();
                    chunks.push(TXChunkFrame.Serialize(this.sid, new_txid, seq++, chunk));
                    totalSize += chunk.byteLength;
                }
                const start_frame = TXStartFrame.Serialize(this.sid, start_ack_id, new_txid, streamName, totalSize);
                await this.send(start_frame);
                const fetchHandler = async (txId, start, end) => {
                    if (txId !== new_txid)
                        return;
                    try {
                        signal.throwIfAborted();
                        for (let i = start; i < end; i++) {
                            const chunk_frame = TXChunkFrame.Serialize(this.sid, new_txid, seq++, chunks[i]);
                            await this.send(chunk_frame);
                        }
                        if (end >= chunks.length) {
                            const finish_ack_id = this.next_ack();
                            const finish_frame = TXFinishFrame.Serialize(this.sid, finish_ack_id, new_txid);
                            await this.send(finish_frame);
                            this.removeListener("tx-fetch", fetchHandler);
                        }
                    }
                    catch (reason) {
                        this.removeListener("tx-fetch", fetchHandler);
                        this.outgoingStreams.delete(new_txid);
                        /*
                                                this.log(`Transaction ${txId} was aborted by client.`);
                        */
                        return;
                    }
                };
                this.addListener("tx-fetch", fetchHandler);
            }
            catch (reason) {
                this.outgoingStreams.delete(new_txid);
                /*
                                this.log(`Transaction ${new_txid} was aborted by client.`);
                */
                return;
            }
        });
    }
    async handle(frame) {
        const type = BufferUtil.GetType(frame);
        switch (type) {
            case BinaryMessageType.TX_START:
                await this.HandleTxStart(frame);
                return;
            case BinaryMessageType.TX_CHUNK:
                await this.HandleTxChunk(frame);
                return;
            case BinaryMessageType.TX_FINISH:
                await this.HandleTxFinish(frame);
                return;
            case BinaryMessageType.TX_FLOW:
                await this.HandleTxFlow(frame);
                return;
            case BinaryMessageType.TX_FETCH:
                await this.HandleTxFetch(frame);
                return;
            case BinaryMessageType.TX_CANCEL:
                await this.HandleTxCancel(frame);
        }
    }
    async HandleTxStart(frame) {
        if (this.abortIfMismatched())
            return;
        const decodedStartFrame = TXStartFrame
            .Deserialize(frame);
        const stream = new Readable({
            read() {
            }
        });
        const { txId, txName } = decodedStartFrame;
        //Handle stream
        stream.on("close", () => {
            this.incomingStreams.delete(txId);
        });
        Object.defineProperty(stream, "txId", { value: txId });
        this.incomingStreams.set(txId, stream);
        await this.acknowledge(decodedStartFrame.ack);
        this.emit("tx-start", txId, txName);
    }
    async HandleTxCancel(frame) {
        if (this.abortIfMismatched())
            return;
        const decodedCancelFrame = TXCancelFrame
            .Deserialize(frame);
        const { txId } = decodedCancelFrame;
        if (!this.outgoingStreams.has(txId))
            return;
        this.outgoingStreams.get(txId)?.abort("Cancelled by client.");
        await this.acknowledge(decodedCancelFrame.ack);
    }
    async HandleTxFinish(frame) {
        if (this.abortIfMismatched())
            return;
        const decodedFinishFrame = TXFinishFrame
            .Deserialize(frame);
        const { txId } = decodedFinishFrame;
        //Handle stream
        if (!this.incomingStreams.has(txId))
            return;
        this.incomingStreams.get(txId).push(null);
        await this.acknowledge(decodedFinishFrame.ack);
        this.emit("tx-finish", txId);
    }
    async HandleTxFetch(frame) {
        if (this.abortIfMismatched())
            return;
        const decodedFetchFrame = TXFetchFrame
            .Deserialize(frame);
        await this.acknowledge(decodedFetchFrame.ack);
        this.emit("tx-fetch", decodedFetchFrame.txId, decodedFetchFrame.start, decodedFetchFrame.end);
    }
    async HandleTxChunk(frame) {
        if (this.abortIfMismatched())
            return;
        const decodedChunkFrame = TXChunkFrame
            .Deserialize(frame);
        const { payload, txId } = decodedChunkFrame;
        if (!this.incomingStreams.has(txId))
            return;
        this.incomingStreams.get(txId).push(payload);
        this.emit("tx-chunk", txId, payload);
    }
    async HandleTxFlow(frame) {
        if (this.abortIfMismatched())
            return;
        const decodedFlowFrame = TXFlowFrame
            .Deserialize(frame);
        this.outgoingFlowControl = decodedFlowFrame.behaviour;
        await this.acknowledge(decodedFlowFrame.ack);
    }
    async acknowledge(ack_id) {
        const encodedACKMessage = ACKFrame
            .Serialize(this.sid, ack_id);
        await this.send(encodedACKMessage);
    }
    abortIfMismatched() {
        if (!cryoHasFeatureFlag(this.get_features(), CRYO_FEATURE_MASK_TRANSACTION)) {
            this.destroy(4002, "PROTOCOL FEATURE MISMATCH - The connected client does not support features in the namespace 'Cryo.Transaction' !");
            return true;
        }
        return false;
    }
}
