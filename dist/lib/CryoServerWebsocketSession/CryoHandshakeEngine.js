import { createECDH, createHash } from "node:crypto";
import CryoFrameFormatter from "../Common/CryoBinaryMessage/CryoFrameFormatter.js";
export var HandshakeState;
(function (HandshakeState) {
    HandshakeState[HandshakeState["INITIAL"] = 0] = "INITIAL";
    HandshakeState[HandshakeState["WAIT_CLIENT_HELLO"] = 1] = "WAIT_CLIENT_HELLO";
    HandshakeState[HandshakeState["WAIT_CLIENT_DONE"] = 2] = "WAIT_CLIENT_DONE";
    HandshakeState[HandshakeState["SECURE"] = 3] = "SECURE";
})(HandshakeState || (HandshakeState = {}));
export class CryoHandshakeEngine {
    sid;
    send_plain;
    formatter;
    next_ack;
    events;
    ECDH_CURVE_NAME = "prime256v1";
    handshake_state = HandshakeState.INITIAL;
    ecdh = createECDH(this.ECDH_CURVE_NAME);
    transmit_key = null;
    receive_key = null;
    constructor(sid, send_plain, formatter, next_ack, events) {
        this.sid = sid;
        this.send_plain = send_plain;
        this.formatter = formatter;
        this.next_ack = next_ack;
        this.events = events;
        this.ecdh.generateKeys();
    }
    async start_server_hello() {
        if (this.handshake_state !== HandshakeState.INITIAL)
            return;
        const my_pub_key = this.ecdh.getPublicKey(null, "uncompressed");
        const ack = this.next_ack();
        const hello_frame = this.formatter
            .GetFormatter("server_hello")
            .Serialize(this.sid, ack, my_pub_key);
        /*
                console.warn(`Sending SERVER_HELLO, type=${hello_frame.readUint8(20)}, buf=${hello_frame.toString("hex")}`)
        */
        await this.send_plain(hello_frame);
        this.handshake_state = HandshakeState.WAIT_CLIENT_HELLO;
    }
    async on_client_hello(frame) {
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
        this.transmit_key = hash.subarray(0, 16);
        this.receive_key = hash.subarray(16, 32);
        //Tell the session that we got the keys, but we don't wanna encrypt just yet
        this.handshake_state = HandshakeState.WAIT_CLIENT_DONE;
        //Send HANDSHAKE_DONE
        const done = CryoFrameFormatter
            .GetFormatter("handshake_done")
            .Serialize(this.sid, decoded.ack, null);
        await this.send_plain(done);
    }
    on_client_handshake_done(frame) {
        if (this.handshake_state !== HandshakeState.WAIT_CLIENT_DONE) {
            this.events.onFailure(`HANDSHAKE_DONE received while in state ${this.state}`);
            return;
        }
        this.events.onSecure({ receive_key: this.receive_key, transmit_key: this.transmit_key });
        //Client got our SERVER_HELLO and finished on its side
        this.handshake_state = HandshakeState.SECURE;
    }
    get is_secure() {
        return this.handshake_state === HandshakeState.SECURE;
    }
    get state() {
        return this.handshake_state;
    }
}
