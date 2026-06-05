import {
    ACKFrame,
    BinaryMessageType,
    BufferUtil, ByeFrame, CRYO_FEATURE_MASK_TRANSACTION,
    CRYO_FLOW_BEHAVIOUR, cryoHasFeatureFlag,
    TXCancelFrame, TXChunkFrame,
    TXFetchFrame, TXFinishFrame,
    TXFlowFrame, TXStartFrame
} from "cryo-protocol";
import {Duplex, Readable} from "node:stream";
import {EventEmitter} from "node:events";
import {ICryoServerWebsocketSessionEvents} from "../CryoServerWebsocketSession.js";
import {CryoFrameInspector} from "../../Common/CryoFrameInspector/CryoFrameInspector.js";
import ws from "ws";
import {AckTracker} from "../../Common/AckTracker/AckTracker.js";

type CryoReadable = Readable & { txId: number };

interface CryoTransactionManagerEvents {
    "tx-start": (txId: number, txName: string) => Promise<void>;
    "tx-chunk": (txId: number, data: Buffer) => Promise<void>;
    "tx-finish": (txId: number) => Promise<void>;
    "tx-fetch": (txId: number, start: number, end: number) => Promise<void>;
}

export interface CryoTransactionManager {
    on<U extends keyof CryoTransactionManagerEvents>(event: U, listener: CryoTransactionManagerEvents[U]): this;

    emit<U extends keyof CryoTransactionManagerEvents>(event: U, ...args: Parameters<CryoTransactionManagerEvents[U]>): boolean;
}

export class CryoTransactionManager extends EventEmitter implements CryoTransactionManager {
    private outgoingFlowControl: CRYO_FLOW_BEHAVIOUR = CRYO_FLOW_BEHAVIOUR.TX_PUSH;
    private readonly incomingStreams = new Map<number, CryoReadable>();
    private readonly outgoingStreams = new Map<number, AbortController>();

    public constructor(
        private sid: bigint,
        private send: (frame: Buffer) => Promise<void>,
        private next_ack: () => number,
        private next_txid: () => number,
        private destroy: (code?: number, message?: string) => void,
        private get_features: () => bigint,
        private waitUntilEmpty: () => Promise<void>
    ) {
        super();
    }

    /**
     * Stream a readable to the client
     * @param source The {@link Readable} object to be streamed
     * @param streamName Optionally, the name of the stream
     * */
    public async Stream(source: Readable, streamName: string = "anonymous") {
        if (this.outgoingFlowControl !== CRYO_FLOW_BEHAVIOUR.TX_PUSH)
            return this.StreamPull(source, streamName);

        return this.StreamPush(source, streamName);
    }

    /**
     * Wait for an incoming stream
     * @param streamName The name of the stream to wait for - leave empty to wait for an unnamed stream
     * @param timeout The amount of milliseconds to wait until the operation should be cancelled if no matching stream was received
     * */
    public async WaitForStream(streamName: string = "anonymous", timeout: number = 2500): Promise<CryoReadable> {
        const timeoutSig = AbortSignal.timeout(timeout);

        return new Promise<CryoReadable>((resolve, reject) => {
            const onTxStartListener = async (txId: number, txName: string) => {
                if (txName === streamName) {
                    if (!this.incomingStreams.has(txId)) {
                        this.off("tx-start", onTxStartListener);
                        timeoutSig.removeEventListener("abort", onAbort);

                        reject(new Error(`No stream id ${txId} present!`));
                    }

                    const stream = this.incomingStreams.get(txId)!;

                    //Remove this listener once the stream has been read
                    stream.on("close", () => {
                        this.off("tx-start", onTxStartListener);
                    })

                    resolve(stream);
                }
            }

            const onAbort = () => {
                this.off("tx-start", onTxStartListener);
                timeoutSig.removeEventListener("abort", onAbort);
                reject(new Error(`Timeout elapsed!`));
            }

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
    public async StreamRequestRange(stream: CryoReadable, start: number, end: number): Promise<void> {
        const fetch_ack_id = this.next_ack();
        const fetch_frame = TXFetchFrame.Serialize(this.sid, fetch_ack_id, stream.txId, start, end);
        await this.send(fetch_frame);
    }

    /**
     * Sets the flow control for this session
     * @param behaviour The flow control behaviour to set the client to
     * */
    public async SetIncomingFlowControl(behaviour: CRYO_FLOW_BEHAVIOUR) {
        const flow_frame = TXFlowFrame.Serialize(this.sid, this.next_ack(), behaviour);
        await this.send(flow_frame);
    }

    private async StreamPush(source: Readable, streamName: string): Promise<void> {
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
            for await(const chunk of source) {
                signal.throwIfAborted();
                const chunk_frame = TXChunkFrame.Serialize(this.sid, new_txid, seq++, chunk);
                await this.send(chunk_frame);
            }

            //send tx_finish
            const finish_ack_id = this.next_ack();
            const finish_frame = TXFinishFrame.Serialize(this.sid, finish_ack_id, new_txid);
            await this.send(finish_frame);

        } catch (reason) {
            //this.log(`Transaction ${new_txid} was aborted by client.`);
        } finally {
            this.outgoingStreams.delete(new_txid);
            await this.waitUntilEmpty();

        }
    }

    private async StreamPull(source: Readable, streamName: string): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            const start_ack_id = this.next_ack();
            const new_txid = this.next_txid();
            const chunks: Buffer[] = [];
            let totalSize = 0;
            let seq = 0;

            const controller = new AbortController();
            const signal = controller.signal;
            this.outgoingStreams.set(new_txid, controller);

            try {
                for await(const chunk of source as AsyncIterable<Buffer>) {
                    signal.throwIfAborted();
                    chunks.push(TXChunkFrame.Serialize(this.sid, new_txid, seq++, chunk));
                    totalSize += chunk.byteLength;
                }

                const start_frame = TXStartFrame.Serialize(this.sid, start_ack_id, new_txid, streamName, totalSize);
                await this.send(start_frame);

                const fetchHandler = async (txId: number, start: number, end: number) => {
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
                    } catch (reason) {
                        this.removeListener("tx-fetch", fetchHandler);
                        this.outgoingStreams.delete(new_txid);
                        /*
                                                this.log(`Transaction ${txId} was aborted by client.`);
                        */
                        return;
                    }
                }
                this.addListener("tx-fetch", fetchHandler);
            } catch (reason) {
                this.outgoingStreams.delete(new_txid);
                /*
                                this.log(`Transaction ${new_txid} was aborted by client.`);
                */
                return;
            }
        });
    }

    public async handle(frame: Buffer) {
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

    private async HandleTxStart(frame: Buffer) {
        if (this.abortIfMismatched())
            return;

        const decodedStartFrame = TXStartFrame
            .Deserialize(frame);

        const stream = new Readable({
            read() {
            }
        });

        const {txId, txName} = decodedStartFrame;

        //Handle stream
        stream.on("close", () => {
            this.incomingStreams.delete(txId);
        });

        Object.defineProperty(stream, "txId", {value: txId});
        this.incomingStreams.set(txId, stream as CryoReadable);

        await this.acknowledge(decodedStartFrame.ack);

        this.emit("tx-start", txId, txName);
    }

    private async HandleTxCancel(frame: Buffer) {
        if (this.abortIfMismatched())
            return;

        const decodedCancelFrame = TXCancelFrame
            .Deserialize(frame);

        const {txId} = decodedCancelFrame;

        if (!this.outgoingStreams.has(txId))
            return;

        this.outgoingStreams.get(txId)?.abort("Cancelled by client.");
        await this.acknowledge(decodedCancelFrame.ack);
    }

    private async HandleTxFinish(frame: Buffer) {
        if (this.abortIfMismatched())
            return;

        const decodedFinishFrame = TXFinishFrame
            .Deserialize(frame);

        const {txId} = decodedFinishFrame;

        //Handle stream
        if (!this.incomingStreams.has(txId))
            return;
        this.incomingStreams.get(txId)!.push(null);

        await this.acknowledge(decodedFinishFrame.ack);

        this.emit("tx-finish", txId);
    }

    private async HandleTxFetch(frame: Buffer) {
        if (this.abortIfMismatched())
            return;

        const decodedFetchFrame = TXFetchFrame
            .Deserialize(frame);

        await this.acknowledge(decodedFetchFrame.ack);

        this.emit("tx-fetch", decodedFetchFrame.txId, decodedFetchFrame.start, decodedFetchFrame.end);
    }

    private async HandleTxChunk(frame: Buffer) {
        if (this.abortIfMismatched())
            return;

        const decodedChunkFrame = TXChunkFrame
            .Deserialize(frame);

        const {payload, txId} = decodedChunkFrame;

        if (!this.incomingStreams.has(txId))
            return;

        this.incomingStreams.get(txId)!.push(payload);

        this.emit("tx-chunk", txId, payload);
    }

    private async HandleTxFlow(frame: Buffer) {
        if (this.abortIfMismatched())
            return;

        const decodedFlowFrame = TXFlowFrame
            .Deserialize(frame);

        this.outgoingFlowControl = decodedFlowFrame.behaviour;

        await this.acknowledge(decodedFlowFrame.ack);
    }

    private async acknowledge(ack_id: number) {
        const encodedACKMessage = ACKFrame
            .Serialize(this.sid, ack_id);

        await this.send(encodedACKMessage);
    }

    private abortIfMismatched() {
        if (!cryoHasFeatureFlag(this.get_features(), CRYO_FEATURE_MASK_TRANSACTION)) {
            this.destroy(4002, "PROTOCOL FEATURE MISMATCH - The connected client does not support features in the namespace 'Cryo.Transaction' !");
            return true;
        }

        return false;
    }
}