import { clearInterval } from "node:timers";
import Guard from "../Common/Util/Guard.js";
import { BufferUtil, BinaryMessageType } from "cryo-protocol";
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
/*
* Absolutely satanic piece of software I wrote while high on kush and using chat gpt 4 for small parts in the drop policies under try_flush
* */
export class BackpressureManager {
    ws;
    log;
    on_drop;
    queue = [];
    queued_bytes = 0;
    flushing = false;
    paused = false;
    destroyed = false;
    stat_log_tick = setInterval(() => this.log_stats(), 5000);
    retry_tick = null;
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
    schedule_retry() {
        if (this.retry_tick)
            return;
        this.retry_tick = setTimeout(() => {
            this.retry_tick = null;
            this.try_flush();
        }, 5);
    }
    log_stats() {
        const { DROP_POLICY, MAX_QUEUE_SIZE, MAX_QUEUED_BYTES } = this.options;
        this.log(`Max queue elements: ${MAX_QUEUE_SIZE}, Max queued bytes: ${MAX_QUEUED_BYTES}, Drop policy: '${DROP_POLICY}'`);
        this.log(`Queue length: ${this.queue.length}, Queued bytes: ${this.queued_bytes}, Current buffered bytes: ${this.ws.bufferedAmount}`);
    }
    can_send() {
        Guard.CastAs(this.ws);
        return this.ws.readyState === this.ws.OPEN && this.ws._socket.writable;
    }
    async spinUntilWritable() {
        const { LOW_WATERMARK } = this.options;
        while (!this.destroyed && this.ws.readyState === this.ws.OPEN && (this.paused ||
            this.ws.bufferedAmount > LOW_WATERMARK)) {
            this.try_flush();
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    }
    async waitUntilEmpty() {
        while (!this.destroyed &&
            this.ws.readyState === this.ws.OPEN &&
            (this.queue.length > 0 ||
                this.queued_bytes > 0 ||
                this.ws.bufferedAmount > 0)) {
            this.try_flush();
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    }
    enqueue(buffer, key) {
        if (this.destroyed)
            return false;
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
        if (this.destroyed)
            return;
        const { HIGH_WATERMARK, LOW_WATERMARK } = this.options;
        if (this.flushing)
            return;
        //Hysteresis
        if (!this.paused && this.ws.bufferedAmount >= HIGH_WATERMARK) {
            this.paused = true;
            this.log(`try_flush(): Paused at bufferedAmount = ${this.ws.bufferedAmount}`);
            this.schedule_retry();
        }
        if (this.paused) {
            if (this.ws.bufferedAmount > LOW_WATERMARK) {
                this.schedule_retry();
                return;
            }
            this.paused = false;
            this.log(`try_flush(): resumed at bufferedAmount=${this.ws.bufferedAmount}`);
        }
        this.flushing = true;
        try {
            //Bail if we can't send right now
            if (!this.can_send())
                return;
            //While there are queued items, and we're not over the high watermark...
            while (this.queue.length > 0 && this.can_send()) {
                const next = this.queue[0];
                if (this.ws.bufferedAmount + next.buffer.byteLength >= HIGH_WATERMARK) {
                    if (!this.paused) {
                        this.paused = true;
                        this.log(`try_flush(): Paused at bufferedAmount=${this.ws.bufferedAmount}, next=${next.buffer.byteLength}`);
                    }
                    this.schedule_retry();
                    break;
                }
                const item = this.queue.shift();
                Guard.CastAssert(item, item !== undefined, "queued was undefined!");
                this.queued_bytes -= item.buffer.byteLength;
                this.ws.send(item.buffer, { binary: true }, (err) => {
                    this.log(`Error during websocket send() call`, err);
                });
            }
        }
        finally {
            this.flushing = false;
        }
    }
    Destroy() {
        this.destroyed = true;
        if (this.stat_log_tick)
            clearInterval(this.stat_log_tick);
        if (this.retry_tick)
            clearInterval(this.retry_tick);
        this.stat_log_tick = null;
        this.queue.length = 0;
        this.queued_bytes = 0;
        this.queue = [];
    }
}
