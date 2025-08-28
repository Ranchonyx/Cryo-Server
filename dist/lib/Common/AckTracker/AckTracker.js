import { CreateDebugLogger } from "../Util/CreateDebugLogger.js";
import { CryoFrameInspector } from "../CryoFrameInspector/CryoFrameInspector.js";
export class AckTracker {
    MAX_STATE_DURATION_MS;
    log;
    pending = new Map();
    ewma_rtt = null;
    alpha = 0.2;
    constructor(MAX_STATE_DURATION_MS = 2500, log = CreateDebugLogger("CRYO_SERVER_ACK")) {
        this.MAX_STATE_DURATION_MS = MAX_STATE_DURATION_MS;
        this.log = log;
    }
    Track(ack, message) {
        this.pending.set(ack, message);
    }
    Confirm(ack) {
        const maybe_ack = this.pending.get(ack);
        if (!maybe_ack)
            return null;
        //Compute exponentially weighted moving average rtt, like in TCP
        const rtt = Date.now() - maybe_ack.timestamp;
        if (!this.ewma_rtt)
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
    Sweep() {
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
    get rtt() {
        return this.ewma_rtt || -1;
    }
    Destroy() {
        this.pending.clear();
    }
}
