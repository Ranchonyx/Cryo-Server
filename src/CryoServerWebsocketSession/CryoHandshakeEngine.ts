import {createECDH, createHash, UUID} from "node:crypto";
import CryoFrameFormatter from "../Common/CryoBinaryMessage/CryoFrameFormatter.js";

export enum HandshakeState {
    INITIAL = 0,
    WAIT_CLIENT_HELLO = 1,
    WAIT_CLIENT_DONE = 2,
    SECURE = 3
}

type CryptoKeys = { receive_key: Buffer, transmit_key: Buffer };

export interface HandshakeEvents {
    onSecure: (keys: CryptoKeys) => void;
    onFailure: (reason: string) => void;
}

export class CryoHandshakeEngine {
    private readonly ECDH_CURVE_NAME = "prime256v1";
    private handshake_state: HandshakeState = HandshakeState.INITIAL;
    private ecdh = createECDH(this.ECDH_CURVE_NAME);

    public constructor(
        private readonly sid: UUID,
        private send_plain: (buf: Buffer) => Promise<void>,
        private formatter: typeof CryoFrameFormatter,
        private next_ack: () => number,
        private events: HandshakeEvents
    ) {
        this.ecdh.generateKeys();
    }

    public async start_server_hello(): Promise<void> {
        if (this.handshake_state !== HandshakeState.INITIAL)
            return;

        const my_pub_key = this.ecdh.getPublicKey(null, "uncompressed");
        const ack = this.next_ack();

        const hello_frame = this.formatter
            .GetFormatter("server_hello")
            .Serialize(this.sid, ack, my_pub_key);

        console.warn(`Sending SERVER_HELLO, type=${hello_frame.readUint8(20)}, buf=${hello_frame.toString("hex")}`)

        await this.send_plain(hello_frame);
        this.handshake_state = HandshakeState.WAIT_CLIENT_HELLO;
    }

    public async on_client_hello(frame: Buffer): Promise<void> {
        if (this.handshake_state !== HandshakeState.WAIT_CLIENT_HELLO) {
            this.events.onFailure(`CLIENT_HELLO received while in state ${this.state}`);
            return;
        }

        const decoded = CryoFrameFormatter
            .GetFormatter("client_hello")
            .Deserialize(frame);

        const client_pub_key = decoded.payload;

        //Derive the keys
        const secret = this.ecdh.computeSecret(client_pub_key);
        const hash = createHash("sha256").update(secret).digest();
        const transmit_key = hash.subarray(0, 16);
        const receive_key = hash.subarray(16, 32);

        //Tell the session that we got the keys, but we don't wanna encrypt just yet
        this.handshake_state = HandshakeState.WAIT_CLIENT_DONE;
        this.events.onSecure({receive_key, transmit_key});

        //Send HANDSHAKE_DONE
        const done = CryoFrameFormatter
            .GetFormatter("handshake_done")
            .Serialize(this.sid, decoded.ack, null);

        await this.send_plain(done);
    }

    public on_client_handshake_done(frame: Buffer): void {
        if(this.handshake_state !== HandshakeState.WAIT_CLIENT_DONE) {
            this.events.onFailure(`HANDSHAKE_DONE received while in state ${this.state}`);
            return;
        }

        //Client got our SERVER_HELLO and finished on its side
        this.handshake_state = HandshakeState.SECURE;
    }


    public get is_secure(): boolean {
        return this.handshake_state === HandshakeState.SECURE;
    }

    public get state(): HandshakeState {
        return this.handshake_state;
    }

}