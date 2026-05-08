import type ws from "ws";
import {clearInterval} from "node:timers";
import Guard from "../Util/Guard.js";
import type {Socket} from "node:net";
import type {DebugLoggerFunction} from "node:util";
import {BufferUtil} from "../Protocol/BufferUtil.js";
import {BinaryMessageType} from "../Protocol/defs.js";

export type DropPolicy = "drop-oldest" | "drop-newest" | "dedupe-latest";

export interface BackpressureOpts {
    HIGH_WATERMARK: number;
    LOW_WATERMARK: number;
    MAX_QUEUED_BYTES: number;
    MAX_QUEUE_SIZE: number;
    DROP_POLICY: DropPolicy;
}

const BACKPRESSURE_PROFILES = {
    optimize_latency: {
        DROP_POLICY: "drop-oldest",
        HIGH_WATERMARK: 512 * 1024,
        LOW_WATERMARK: 128 * 1024,
        MAX_QUEUED_BYTES: 4 * 1024 * 1024,
        MAX_QUEUE_SIZE: 512,
    },

    optimize_memory: {
        DROP_POLICY: "drop-oldest",
        HIGH_WATERMARK: 256 * 1024,
        LOW_WATERMARK: 64 * 1024,
        MAX_QUEUED_BYTES: 2 * 1024 * 1024,
        MAX_QUEUE_SIZE: 256,
    },

    default: {
        DROP_POLICY: "drop-oldest",
        HIGH_WATERMARK: 4 * 1024 * 1024,
        LOW_WATERMARK: 1 * 1024 * 1024,
        MAX_QUEUED_BYTES: 32 * 1024 * 1024,
        MAX_QUEUE_SIZE: 4096,
    },
} satisfies Record<string, BackpressureOpts>;

/**
 * optimize_latency: small buffers, lower queueing delay
 *
 * optimize_memory: strict capacities, lowest mem usage
 *
 * default: fairly balanced throughput and memory use
 * */
export type BackpressureProfile = keyof typeof BACKPRESSURE_PROFILES;

interface FrameQueueItem {
    buffer: Buffer;
    key?: string;
    ts: number;
}

export class BackpressureManager {
    private queue: FrameQueueItem[] = []
    private queued_bytes = 0;

    private flushing: boolean = false;
    private paused: boolean = false;

    private stat_log_tick: NodeJS.Timeout | null = setInterval(() => this.log_stats(), 5000);

    private readonly options: BackpressureOpts;

    public constructor(private ws: ws, options: Required<BackpressureOpts> | BackpressureProfile, private log: DebugLoggerFunction, private on_drop?: (item: FrameQueueItem) => void) {
        this.options = typeof options === "string" ? BACKPRESSURE_PROFILES[options] : options
        Guard.CastAs<typeof ws & { _socket: Socket }>(this.ws);
        if (this.ws?._socket) {
            // noinspection PointlessBooleanExpressionJS
            Guard.CastAssert(this.ws._socket, this.ws?._socket !== undefined, "ws._socket was undefined!");
            this.ws?._socket?.on?.("drain", () => this.try_flush());
        }
    }

    private log_stats() {
        const {DROP_POLICY, MAX_QUEUE_SIZE, MAX_QUEUED_BYTES} = this.options;
        this.log(`Max queue elements: ${MAX_QUEUE_SIZE}, Max queued bytes: ${MAX_QUEUED_BYTES}, Drop policy: '${DROP_POLICY}'`);
        this.log(`Queue length: ${this.queue.length}, Queued bytes: ${this.queued_bytes}, Current buffered bytes: ${this.ws.bufferedAmount}`);
    }

    private can_send() {
        const {HIGH_WATERMARK} = this.options;
        Guard.CastAs<typeof ws & { _socket: Socket }>(this.ws);
        return this.ws.readyState === this.ws.OPEN &&
            this.ws.bufferedAmount < HIGH_WATERMARK &&
            this.ws._socket.writable;
    }

    public enqueue(buffer: Buffer, key?: string): boolean {
        const {DROP_POLICY, MAX_QUEUE_SIZE, MAX_QUEUED_BYTES} = this.options;
        const type = BufferUtil.GetType(buffer);


        //Transaction frames form an ordered stream, may never be dropped or reordered
        //because that will corrupt the stream
        const isTransactionFrame = type === BinaryMessageType.TX_START || type === BinaryMessageType.TX_CHUNK || type === BinaryMessageType.TX_FINISH;

        if (DROP_POLICY === "dedupe-latest" && key && !isTransactionFrame) {
            for (let i = this.queue.length - 1; i >= 0; i--) {
                const item = this.queue[i];
                if (item.key === key) {
                    this.queued_bytes -= item.buffer.byteLength;
                    this.queue.splice(i, 1);
                    break;
                }
            }
        }

        const enqueueWouldExceedMaxQueueSize = this.queue.length + 1 > MAX_QUEUE_SIZE;
        const wouldExceedQueuedBytes = this.queued_bytes + buffer.byteLength > MAX_QUEUED_BYTES;

        if (wouldExceedQueuedBytes || enqueueWouldExceedMaxQueueSize) {
            if (DROP_POLICY === "drop-newest")
                return false;

            if (DROP_POLICY === "drop-oldest") {
                if (this.queue.length > 0) {
                    const victimIndex = this.queue.findIndex(item => {
                        const itemType = BufferUtil.GetType(item.buffer);

                        return itemType !== BinaryMessageType.TX_START &&
                            itemType !== BinaryMessageType.TX_CHUNK &&
                            itemType !== BinaryMessageType.TX_FINISH;
                    });

                    if (victimIndex === -1) {
                        return false;
                    }

                    const evicted_item = this.queue.splice(victimIndex, 1)[0];
                    Guard.CastAssert<FrameQueueItem>(evicted_item, evicted_item !== undefined, "evicted_item was undefined!");
                    this.queued_bytes -= evicted_item.buffer.byteLength;

                    this.on_drop?.(evicted_item);
                } else {
                    return false;
                }
            }
        }

        //Yeet the item if we are still exceeding the limit
        if (DROP_POLICY === "dedupe-latest" && !isTransactionFrame) {
            const areWeStillExceeding = (this.queue.length + 1 > MAX_QUEUE_SIZE) || (this.queued_bytes + buffer.byteLength > MAX_QUEUED_BYTES);
            if (areWeStillExceeding)
                return false;
        }

        this.queue.push({buffer, key, ts: Date.now()});
        this.queued_bytes += buffer.byteLength;

        //Try sending the queue right now
        this.try_flush();

        return true;
    }

    public try_flush(): void {
        const {HIGH_WATERMARK, LOW_WATERMARK} = this.options;
        if (this.flushing)
            return;

        //Hysteresis
        if (this.ws.bufferedAmount >= HIGH_WATERMARK) {
            this.log(`try_flush(): Exceeded or reached HIGH_WATERMARK ${HIGH_WATERMARK}, pausing`);
            this.paused = true;
        }

        if (this.paused && this.ws.bufferedAmount > LOW_WATERMARK) {
            this.log(`try_flush(): Refusing to flush while paused and still exceeding LOW_WATERMARK ${LOW_WATERMARK}`);
            return;
        }

        this.paused = false;

        this.flushing = true;
        try {
            //Bail if we can't send right now
            if (!this.can_send())
                return;

            //While there are queued items, and we're not over the high watermark...
            while (this.queue.length > 0 && this.ws.bufferedAmount < HIGH_WATERMARK) {

                //Grab the enqueued item...
                const item = this.queue.shift();
                Guard.CastAssert<FrameQueueItem>(item, item !== undefined, "queued was undefined!");

                this.queued_bytes -= item.buffer.byteLength;

                //And down the wire it goes!
                this.ws.send(item.buffer, {binary: true}, (err) => {
                    if (err)
                        return;

                    this.try_flush();
                });

                //Pause sending data and wait for 'drain' event on the socket
                if (this.ws.bufferedAmount >= HIGH_WATERMARK)
                    break;
            }
        } finally {
            this.flushing = false;
        }
    }

    public Destroy() {
        if (this.stat_log_tick)
            clearInterval(this.stat_log_tick);

        this.stat_log_tick = null;
        this.queue.length = 0;
        this.queued_bytes = 0;

        this.queue = [];
    }
}