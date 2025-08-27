import ws from "ws";
import {DropPolicy} from "../../CryoWebsocketServer/types/CryoWebsocketServer.js";
import {clearInterval} from "node:timers";
import Guard from "../Util/Guard.js";
import {Socket} from "node:net";

type MessagePriority = "control" | "data";

interface MessageQueueItem {
    buffer: Buffer;
    priority: MessagePriority;
    key?: string;
    ts: number;
}

export class BackpressureManager {
    private queue: MessageQueueItem[] = []
    private queued_bytes = 0;
    private tick: NodeJS.Timeout | null = null;

    public constructor(private ws: ws, private WM_HI: number, private WM_LO: number, private MAX_Q_BYTES: number, private MAX_Q_COUNT: number, private drop: DropPolicy, private on_drop?: (item: MessageQueueItem) => void) {

        Guard.CastAs<typeof ws & {_socket: Socket}>(this.ws);
        if (this.ws._socket) {
            Guard.CastAssert(this.ws._socket, this.ws._socket !== undefined, "ws._socket was undefined!");
            this.ws?._socket?.on?.("drain", () => this.try_flush());
        }

        this.tick = setInterval(() => this.try_flush(), 500);
    }

    private can_send() {
        return this.ws.readyState === this.ws.OPEN && this.ws.bufferedAmount < this.WM_HI;
    }

    public enqueue(buffer: Buffer, priority: MessagePriority = "control", /*callback: (err?: Error) => void,*/ key?: string): boolean {
        //If we got ctrl traffic, try to bypass queue entirely, so long as we can send it now...
        if(priority === "control" && this.can_send()) {
            this.ws.send(buffer, {binary: true});
            return true;
        }

        if(this.drop === "dedupe-latest" && key) {
            for(let i = this.queue.length; i >= 0; i--) {
                const item = this.queue[i];
                if(item.key === key) {
                    this.queued_bytes -= item.buffer.byteLength;
                    this.queue.splice(i, 1);
                    break;
                }
            }
        }

        const enqueueWouldExceedMaxQueues = this.queue.length + 1 > this.MAX_Q_COUNT;
        const wouldExceedQueuedBytes = this.queued_bytes + buffer.byteLength > this.MAX_Q_BYTES;

        if(wouldExceedQueuedBytes || enqueueWouldExceedMaxQueues) {
            if(this.drop === "drop-newest")
                return false;

            if(this.drop === "drop-oldest") {
                if(this.queue.length > 0) {
                    const evicted_item = this.queue.shift();
                    Guard.CastAssert<MessageQueueItem>(evicted_item, evicted_item !== undefined, "evicted_item was undefined!");
                    this.queued_bytes -= evicted_item.buffer.byteLength;

                    this.on_drop?.(evicted_item);
                } else {
                    return false;
                }
            }
        }

        //Yeet the item if we are still exceeding the limit
        if(this.drop === "dedupe-latest") {
            const areWeStillExceeding = (this.queue.length + 1 > this.MAX_Q_COUNT) || (this.queued_bytes + buffer.byteLength > this.MAX_Q_BYTES);
            if(areWeStillExceeding)
                return false;
        }

        this.queue.push({buffer, priority, key, ts: Date.now()});
        this.queued_bytes += buffer.byteLength;

        //Try sending the queue right now
        this.try_flush();

        return true;
    }

    public try_flush(): void {
        if(!this.can_send())
            return;

        //Give control frames priority when being sent
        if(this.queue.length > 1)
            this.queue.sort((iA, iB) => (iA.priority === iB.priority) ? 0 : (iA.priority === "control" ? -1 : 1));

        while(this.queue.length > 0 && this.ws.bufferedAmount < this.WM_HI) {
            const item = this.queue.shift();
            Guard.CastAssert<MessageQueueItem>(item, item !== undefined, "evicted_item was undefined!");

            this.queued_bytes -= item.buffer.byteLength;
            this.ws.send(item.buffer, {binary: true});

            //Pause sending data and wait for 'drain' event on the socket
            if(this.ws.bufferedAmount >= this.WM_HI)
                break;
        }
    }

    public Destroy() {
        if(this.tick)
            clearInterval(this.tick);

        this.tick = null;
        this.queue.length = 0;
        this.queued_bytes = 0;
    }
}