import { CreateDebugLogger } from "../Util/CreateDebugLogger.js";
import { CryoFrameInspector } from "../CryoFrameInspector/CryoFrameInspector.js";
import { clearInterval } from "node:timers";
export class AckTracker {
    MAX_STATE_DURATION_MS;
    log;
    pending = new Map();
    tick = null;
    constructor(MAX_STATE_DURATION_MS = 2500, log = CreateDebugLogger(`CRYO_SERVER_ACK`)) {
        this.MAX_STATE_DURATION_MS = MAX_STATE_DURATION_MS;
        this.log = log;
        this.tick = setInterval(this.Sweep.bind(this), 3000);
    }
    Track(ack, message) {
        this.pending.set(ack, message);
    }
    Confirm(ack) {
        const maybe_ack = this.pending.get(ack);
        if (!maybe_ack)
            return null;
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
        for (const [ack, pending] of this.pending.entries()) {
            if ((now - pending.timestamp) >= this.MAX_STATE_DURATION_MS) {
                //Purge that mfer
                this.pending.delete(ack);
                this.log(`Purged message ${CryoFrameInspector.Inspect(pending.message)} (ACK ${ack}) due to being stale for longer than ${this.MAX_STATE_DURATION_MS} milliseconds!`);
            }
        }
    }
    Destroy() {
        clearInterval(this.tick);
        this.tick = null;
        this.pending.clear();
    }
}
