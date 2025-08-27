import {CreateDebugLogger} from "../Util/CreateDebugLogger.js";
import CryoBinaryMessageFormatterFactory from "../CryoBinaryMessage/CryoBinaryMessageFormatterFactory.js";
import {CryoFrameInspector} from "../CryoFrameInspector/CryoFrameInspector.js";
import {clearInterval} from "node:timers";

type PendingBinaryMessage = {
    timestamp: number;
    message: Buffer;
    payload?: string | Buffer;
}

export class AckTracker {
    private pending = new Map<number, PendingBinaryMessage>();
    private tick: NodeJS.Timeout | null = null;

    public constructor(private MAX_STATE_DURATION_MS: number = 2500, private log = CreateDebugLogger(`CRYO_SERVER_ACK`)) {
        this.tick = setInterval(this.Sweep.bind(this), 3000);
    }

    public Track(ack: number, message: PendingBinaryMessage) {
        this.pending.set(ack, message);
    }

    public Confirm(ack: number): PendingBinaryMessage | null {
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

    private Sweep() {
        const now = Date.now();
        this.log("Doing housekeeping...");
        for(const [ack, pending] of this.pending.entries()) {
            if((now - pending.timestamp) >= this.MAX_STATE_DURATION_MS) {
                //Purge that mfer
                this.pending.delete(ack);
                this.log(`Purged message ${CryoFrameInspector.Inspect(pending.message)} (ACK ${ack}) due to being stale for longer than ${this.MAX_STATE_DURATION_MS} milliseconds!`);
            }
        }
    }

    public Destroy() {
        clearInterval(this.tick!);
        this.tick = null;
        this.pending.clear();
    }
}