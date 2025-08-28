import {CreateDebugLogger} from "../Util/CreateDebugLogger.js";
import {CryoFrameInspector} from "../CryoFrameInspector/CryoFrameInspector.js";

type PendingBinaryMessage = {
    timestamp: number;
    message: Buffer;
    payload?: string | Buffer;
}

export class AckTracker {
    private pending = new Map<number, PendingBinaryMessage>();

    private ewma_rtt: number | null = null;
    private alpha = 0.2;

    public constructor(private MAX_STATE_DURATION_MS: number = 2500, private log = CreateDebugLogger("CRYO_SERVER_ACK")) {
    }

    public Track(ack: number, message: PendingBinaryMessage) {
        this.pending.set(ack, message);
    }

    public Confirm(ack: number): PendingBinaryMessage | null {
        const maybe_ack = this.pending.get(ack);
        if (!maybe_ack)
            return null;

        //Compute exponentially weighted moving average rtt, like in TCP
        const rtt = Date.now() - maybe_ack.timestamp;
        if(!this.ewma_rtt)
            this.ewma_rtt = rtt;
        else
            this.ewma_rtt = (1 - this.alpha) * this.ewma_rtt + this.alpha * rtt;

        this.log(`ACK ${ack} confirmed in ${Date.now() - maybe_ack.timestamp} ms`);
        this.pending.delete(ack);
        return maybe_ack;
    }

    /*
        public Has(ack: number): boolean {
            return this.pending.has(ack);
        }
    */

    public Sweep(): number {
        const now = Date.now();
        this.log("Doing housekeeping...");

        let purged = 0;
        for (const [ack, pending] of this.pending.entries()) {
            if ((now - pending.timestamp) >= this.MAX_STATE_DURATION_MS) {
                //Purge that mfer
                this.pending.delete(ack);
                this.log(`Purged message ${CryoFrameInspector.Inspect(pending.message)} (ACK ${ack}) due to being stale for longer than ${this.MAX_STATE_DURATION_MS} milliseconds!`);
                purged++;
            }
        }

        return purged;
    }

    public get rtt(): number {
        return this.ewma_rtt || -1;
    }

    public Destroy() {
        this.pending.clear();
    }
}