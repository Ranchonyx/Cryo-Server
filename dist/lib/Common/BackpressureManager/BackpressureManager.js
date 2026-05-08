import { clearInterval } from "node:timers";
import Guard from "../Util/Guard.js";
import { BufferUtil } from "../Protocol/BufferUtil.js";
import { BinaryMessageType } from "../Protocol/defs.js";
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
};
export class BackpressureManager {
    ws;
    log;
    on_drop;
    queue = [];
    queued_bytes = 0;
    flushing = false;
    paused = false;
    stat_log_tick = setInterval(() => this.log_stats(), 5000);
    options;
    constructor(ws, options, log, on_drop) {
        this.ws = ws;
        this.log = log;
        this.on_drop = on_drop;
        this.options = typeof options === "string" ? BACKPRESSURE_PROFILES[options] : options;
        Guard.CastAs(this.ws);
        if (this.ws?._socket) {
            // noinspection PointlessBooleanExpressionJS
            Guard.CastAssert(this.ws._socket, this.ws?._socket !== undefined, "ws._socket was undefined!");
            this.ws?._socket?.on?.("drain", () => this.try_flush());
        }
    }
    log_stats() {
        const { DROP_POLICY, MAX_QUEUE_SIZE, MAX_QUEUED_BYTES } = this.options;
        this.log(`Max queue elements: ${MAX_QUEUE_SIZE}, Max queued bytes: ${MAX_QUEUED_BYTES}, Drop policy: '${DROP_POLICY}'`);
        this.log(`Queue length: ${this.queue.length}, Queued bytes: ${this.queued_bytes}, Current buffered bytes: ${this.ws.bufferedAmount}`);
    }
    can_send() {
        const { HIGH_WATERMARK } = this.options;
        Guard.CastAs(this.ws);
        return this.ws.readyState === this.ws.OPEN &&
            this.ws.bufferedAmount < HIGH_WATERMARK &&
            this.ws._socket.writable;
    }
    enqueue(buffer, key) {
        const { DROP_POLICY, MAX_QUEUE_SIZE, MAX_QUEUED_BYTES } = this.options;
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
                    Guard.CastAssert(evicted_item, evicted_item !== undefined, "evicted_item was undefined!");
                    this.queued_bytes -= evicted_item.buffer.byteLength;
                    this.on_drop?.(evicted_item);
                }
                else {
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
        this.queue.push({ buffer, key, ts: Date.now() });
        this.queued_bytes += buffer.byteLength;
        //Try sending the queue right now
        this.try_flush();
        return true;
    }
    try_flush() {
        const { HIGH_WATERMARK, LOW_WATERMARK } = this.options;
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
                Guard.CastAssert(item, item !== undefined, "queued was undefined!");
                this.queued_bytes -= item.buffer.byteLength;
                //And down the wire it goes!
                this.ws.send(item.buffer, { binary: true }, (err) => {
                    if (err)
                        return;
                    this.try_flush();
                });
                //Pause sending data and wait for 'drain' event on the socket
                if (this.ws.bufferedAmount >= HIGH_WATERMARK)
                    break;
            }
        }
        finally {
            this.flushing = false;
        }
    }
    Destroy() {
        if (this.stat_log_tick)
            clearInterval(this.stat_log_tick);
        this.stat_log_tick = null;
        this.queue.length = 0;
        this.queued_bytes = 0;
        this.queue = [];
    }
}
