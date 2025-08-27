import { clearInterval } from "node:timers";
import Guard from "../Util/Guard.js";
export class BackpressureManager {
    ws;
    WM_HI;
    WM_LO;
    MAX_Q_BYTES;
    MAX_Q_COUNT;
    drop;
    on_drop;
    queue = [];
    queued_bytes = 0;
    tick = null;
    constructor(ws, WM_HI, WM_LO, MAX_Q_BYTES, MAX_Q_COUNT, drop, on_drop) {
        this.ws = ws;
        this.WM_HI = WM_HI;
        this.WM_LO = WM_LO;
        this.MAX_Q_BYTES = MAX_Q_BYTES;
        this.MAX_Q_COUNT = MAX_Q_COUNT;
        this.drop = drop;
        this.on_drop = on_drop;
        Guard.CastAs(this.ws);
        if (this.ws._socket) {
            Guard.CastAssert(this.ws._socket, this.ws._socket !== undefined, "ws._socket was undefined!");
            this.ws?._socket?.on?.("drain", () => this.try_flush());
        }
        this.tick = setInterval(() => this.try_flush(), 500);
    }
    can_send() {
        return this.ws.readyState === this.ws.OPEN && this.ws.bufferedAmount < this.WM_HI;
    }
    enqueue(buffer, priority = "control", /*callback: (err?: Error) => void,*/ key) {
        //If we got ctrl traffic, try to bypass queue entirely, so long as we can send it now...
        if (priority === "control" && this.can_send()) {
            this.ws.send(buffer, { binary: true });
            return true;
        }
        if (this.drop === "dedupe-latest" && key) {
            for (let i = this.queue.length; i >= 0; i--) {
                const item = this.queue[i];
                if (item.key === key) {
                    this.queued_bytes -= item.buffer.byteLength;
                    this.queue.splice(i, 1);
                    break;
                }
            }
        }
        const enqueueWouldExceedMaxQueues = this.queue.length + 1 > this.MAX_Q_COUNT;
        const wouldExceedQueuedBytes = this.queued_bytes + buffer.byteLength > this.MAX_Q_BYTES;
        if (wouldExceedQueuedBytes || enqueueWouldExceedMaxQueues) {
            if (this.drop === "drop-newest")
                return false;
            if (this.drop === "drop-oldest") {
                if (this.queue.length > 0) {
                    const evicted_item = this.queue.shift();
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
        if (this.drop === "dedupe-latest") {
            const areWeStillExceeding = (this.queue.length + 1 > this.MAX_Q_COUNT) || (this.queued_bytes + buffer.byteLength > this.MAX_Q_BYTES);
            if (areWeStillExceeding)
                return false;
        }
        this.queue.push({ buffer, priority, key, ts: Date.now() });
        this.queued_bytes += buffer.byteLength;
        //Try sending the queue right now
        this.try_flush();
        return true;
    }
    try_flush() {
        if (!this.can_send())
            return;
        //Give control frames priority when being sent
        if (this.queue.length > 1)
            this.queue.sort((iA, iB) => (iA.priority === iB.priority) ? 0 : (iA.priority === "control" ? -1 : 1));
        while (this.queue.length > 0 && this.ws.bufferedAmount < this.WM_HI) {
            const item = this.queue.shift();
            Guard.CastAssert(item, item !== undefined, "evicted_item was undefined!");
            this.queued_bytes -= item.buffer.byteLength;
            this.ws.send(item.buffer, { binary: true });
            //Pause sending data and wait for 'drain' event on the socket
            if (this.ws.bufferedAmount >= this.WM_HI)
                break;
        }
    }
    Destroy() {
        if (this.tick)
            clearInterval(this.tick);
        this.tick = null;
        this.queue.length = 0;
        this.queued_bytes = 0;
    }
}
