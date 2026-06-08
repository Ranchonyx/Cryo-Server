import { EventEmitter } from "node:events";
import { CreateDebugLogger } from "../Common/Util/CreateDebugLogger.js";
import { AckTracker } from "../Common/AckTracker/AckTracker.js";
import { BackpressureManager } from "../BackpressureManager/BackpressureManager.js";
import { BinaryMessageType, BufferUtil, ByeFrame, EndpointInfoFrame, } from "cryo-protocol";
import { CryoBaseManager } from "./Namespaces/Cryo.Base.js";
import { CryoTransactionManager } from "./Namespaces/Cryo.Transaction.js";
import { CryoFrameInspector } from "../Common/CryoFrameInspector/CryoFrameInspector.js";
var CloseCode;
(function (CloseCode) {
    CloseCode[CloseCode["CLOSE_GRACEFUL"] = 4000] = "CLOSE_GRACEFUL";
    CloseCode[CloseCode["CLOSE_CLIENT_ERROR"] = 4001] = "CLOSE_CLIENT_ERROR";
    CloseCode[CloseCode["CLOSE_SERVER_ERROR"] = 4002] = "CLOSE_SERVER_ERROR";
})(CloseCode || (CloseCode = {}));
export class CryoServerWebsocketSession extends EventEmitter {
    webSocket;
    tcpSocket;
    remoteName;
    extensionRegistry;
    bp_mgr;
    log;
    client_ack_tracker = new AckTracker();
    storage = {};
    destroyed = false;
    current_ack = 0;
    current_txid = 0;
    bytes_rx = 0;
    bytes_tx = 0;
    receivedProtocolFeatures = 0n;
    base;
    stream = null;
    bind(func) {
        return func.bind(this);
    }
    forwardMessageStrOrBuf(source, event) {
        source.on(event, (message) => this.emit(event, message));
    }
    constructor(webSocket, tcpSocket, remoteName, backpressure_opts, extensionRegistry) {
        super();
        this.webSocket = webSocket;
        this.tcpSocket = tcpSocket;
        this.remoteName = remoteName;
        this.extensionRegistry = extensionRegistry;
        this.log = CreateDebugLogger(`CRYO_SERVER_SESSION`);
        this.bp_mgr = new BackpressureManager(webSocket, backpressure_opts, CreateDebugLogger(`CRYO_BACKPRESSURE`));
        this.base = new CryoBaseManager(this.sid, this.bind(this.send), this.bind(this.next_ack), this.bind(this.Destroy), (features) => this.receivedProtocolFeatures = features, this.extensionRegistry.get_executor(this), this.client_ack_tracker, () => this.webSocket.isAlive = true);
        this.forwardMessageStrOrBuf(this.base, "message-binary");
        this.forwardMessageStrOrBuf(this.base, "message-utf8");
        this.forwardMessageStrOrBuf(this.base, "message-error");
        //set up listeners
        tcpSocket.once("end", this.TCPSOCKET_HandleRemoteEnd.bind(this));
        tcpSocket.once("error", this.TCPSOCKET_HandleRemoteError.bind(this));
        webSocket.on("close", this.WEBSOCKET_HandleRemoteClose.bind(this));
        //Handle incoming ws messages
        webSocket.on("message", async (raw) => {
            this.bytes_rx += raw.byteLength;
            this.routeFrame(raw)
                .catch((err) => {
                this.log(`routeFrame failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
            });
        });
        //Handler first
        this.base.on("ready", () => {
            this.stream = new CryoTransactionManager(this.sid, this.bind(this.send), this.bind(this.next_ack), this.bind(this.next_txid), this.bind(this.Destroy), () => this.receivedProtocolFeatures, this.bp_mgr.waitUntilEmpty.bind(this.bp_mgr));
            this.emit("connected");
        });
        //Then send the first endpointInfo message
        const msg = EndpointInfoFrame.Serialize(this.sid, this.next_ack());
        this.send(msg);
    }
    async routeFrame(frame) {
        const type = BufferUtil.GetType(frame);
        if (type >= BinaryMessageType.BINARYDATA && type <= BinaryMessageType.ENDPOINT_INFO)
            return this.base.handle(frame);
        if (type >= BinaryMessageType.TX_START && type <= BinaryMessageType.TX_CANCEL)
            return this.stream?.handle(frame);
        throw new Error(`Unknown frame type ${type}!`);
    }
    next_ack() {
        if (this.current_ack + 1 > 0xffffffff)
            this.current_ack = 0;
        return this.current_ack++;
    }
    next_txid() {
        if (this.current_txid + 1 > 0xffffffff)
            this.current_txid = 0;
        return this.current_txid++;
    }
    TranslateCloseCode(code) {
        switch (code) {
            case CloseCode.CLOSE_GRACEFUL:
                return "Connection closed normally.";
            case CloseCode.CLOSE_CLIENT_ERROR:
                return "Connection closed due to a client error.";
            case CloseCode.CLOSE_SERVER_ERROR:
                return "Connection closed due to a server error.";
            default:
                return "Unspecified cause for connection closure.";
        }
    }
    async send(outgoing_message, payload) {
        if (this.destroyed)
            return;
        let ackPromise = null;
        //Create a pending message with a new ack number and queue it for acknowledgement by the client
        const type = BufferUtil.GetType(outgoing_message);
        if (type === BinaryMessageType.UTF8DATA ||
            type === BinaryMessageType.BINARYDATA ||
            type === BinaryMessageType.ERROR ||
            type === BinaryMessageType.ENDPOINT_INFO ||
            type === BinaryMessageType.TX_FLOW ||
            type === BinaryMessageType.TX_START ||
            type === BinaryMessageType.TX_FINISH ||
            type === BinaryMessageType.TX_FETCH) {
            const message_ack = BufferUtil.GetAck(outgoing_message);
            ackPromise = Promise.withResolvers();
            this.client_ack_tracker.Track(message_ack, {
                timestamp: Date.now(),
                message: outgoing_message,
                ackPromise,
                payload
            });
        }
        this.log(`OUT ${CryoFrameInspector.Inspect(outgoing_message)}`);
        //Spin until we can send again
        while (true) {
            //Try enqueueing the outgoing message
            const ok = this.bp_mgr.enqueue(outgoing_message);
            if (ok) {
                this.bytes_tx += outgoing_message.byteLength;
                if (!ackPromise)
                    return Promise.resolve();
                return ackPromise.promise;
            }
            //If we were unable, wait until we can enqueue again
            await this.bp_mgr.spinUntilWritable();
        }
    }
    get_ack_tracker() {
        return this.client_ack_tracker;
    }
    //noinspection JSUnusedGlobalSymbols
    get rx() {
        return this.bytes_rx;
    }
    //noinspection JSUnusedGlobalSymbols
    get tx() {
        return this.bytes_tx;
    }
    //noinspection JSUnusedGlobalSymbols
    get sid() {
        return this.webSocket.sessionId;
    }
    //noinspection JSUnusedGlobalSymbols
    async Close(reason) {
        const ack = this.next_ack();
        const frame = ByeFrame.Serialize(this.sid, ack, reason);
        this.client_ack_tracker.Track(ack, { message: frame, timestamp: Date.now() });
        await this.send(frame);
        this.Destroy();
    }
    /*
    Session runtime storage API
    */
    /**
     * @param key Storage key to set to a value
     * @param value The value to write into the key
     * */
    Set(key, value) {
        this.storage[key] = value;
    }
    /**
     * @param key Storage key to retrieve data from
     * */
    Get(key) {
        return this.storage[key];
    }
    /*
    Error handling
    */
    WEBSOCKET_HandleRemoteClose(code, reason) {
        const code_string = this.TranslateCloseCode(code);
        this.log(`Client ${this.remoteName} has disconnected. Code=${code_string}, reason=${reason.toString("utf8")}`);
        this.Destroy(CloseCode.CLOSE_GRACEFUL, "Connection closed gracefully.");
    }
    TCPSOCKET_HandleRemoteEnd() {
        this.log(`TCP Peer '${this.remoteName}' connection closed cleanly by client session.`);
        this.Destroy(CloseCode.CLOSE_GRACEFUL, "Connection closed gracefully.");
    }
    TCPSOCKET_HandleRemoteError(err) {
        this.log(`TCP Peer '${this.remoteName}' threw an error '${err.message}' (${err?.code})`);
        this.Destroy(CloseCode.CLOSE_CLIENT_ERROR, "Connection closed erroneously.");
    }
    //noinspection JSUnusedGlobalSymbols
    Destroy(code = 4000, message = "Closing session.") {
        this.bp_mgr?.Destroy();
        this.client_ack_tracker?.Destroy();
        try {
            this.log(`Teardown of session. Code=${code}, reason=${message}`);
            this.webSocket.close(code, message);
        }
        catch {
            //Ignore
        }
        if (!this.destroyed)
            this.emit("closed");
        this.destroyed = true;
    }
}
