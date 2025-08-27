import http from "node:http";
import { WebSocketServer } from "ws";
import { clearInterval, setInterval } from "node:timers";
import { EventEmitter } from "node:events";
import Guard from "../Common/Util/Guard.js";
import { CryoServerWebsocketSession } from "../CryoServerWebsocketSession/CryoServerWebsocketSession.js";
import { CreateDebugLogger } from "../Common/Util/CreateDebugLogger.js";
import { CryoExtensionRegistry } from "../CryoExtension/CryoExtensionRegistry.js";
import { OverwriteUnset } from "../Common/Util/OverwriteUnset.js";
export class CryoWebsocketServer extends EventEmitter {
    server;
    tokenValidator;
    backpressure_options;
    ws_server;
    WebsocketHearbeatInterval;
    sessions = [];
    log;
    static async Create(pTokenValidator, options) {
        const keepAliveInterval = options && options.keepAliveIntervalMs || 15000;
        const sockPort = options && options.port || 8080;
        const server = http.createServer();
        const backpressure = options && options.backpressure || {};
        const bpres_opts_filled = OverwriteUnset(backpressure, {
            dropPolicy: "drop-oldest",
            highWaterMark: 4 * 1024 * 1024,
            lowWaterMark: 1 * 1024 * 1024,
            maxQueuedBytes: 8 * 1024 * 1024,
            maxQueueCount: 1024,
        });
        return new CryoWebsocketServer(server, pTokenValidator, keepAliveInterval, sockPort, bpres_opts_filled);
    }
    constructor(server, tokenValidator, keepAliveInterval, socketPort, backpressure_options) {
        super();
        this.server = server;
        this.tokenValidator = tokenValidator;
        this.backpressure_options = backpressure_options;
        this.log = CreateDebugLogger("CRYO_SERVER");
        this.ws_server = new WebSocketServer({ noServer: true });
        this.WebsocketHearbeatInterval = setInterval(this.Heartbeat.bind(this), keepAliveInterval)
            .ref();
        this.server.on("upgrade", this.HTTPUpgradeCallback.bind(this));
        this.server.listen(socketPort, () => {
            this.emit("listening");
        });
    }
    __denyAndDestroy(pSocket, message) {
        const response = `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n`;
        pSocket.write(response, () => {
            pSocket.end(() => {
                this.log(message);
            });
        });
    }
    async HTTPUpgradeCallback(request, socket, head) {
        const socketFmt = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
        this.log(`Upgrade request from ${socketFmt} ...`);
        const full_host_url = new URL(`ws://${process.env.HOST ?? 'localhost'}${request.url}`);
        const authorization = full_host_url.searchParams.get("authorization");
        const x_cryo_sid = full_host_url.searchParams.get("x-cryo-sid");
        //Check auth header
        if (!authorization) {
            this.__denyAndDestroy(socket, `Upgrade request for ${socketFmt} was refused. No authorization header.`);
            return;
        }
        if (!authorization.startsWith("Bearer")) {
            this.__denyAndDestroy(socket, `Upgrade request for ${socketFmt} was refused. No bearer authorization in header.`);
            return;
        }
        //Check x-cryo-sid header
        if (!x_cryo_sid) {
            this.__denyAndDestroy(socket, `Upgrade request for ${socketFmt} was refused. No SID in 'x-cryo-sid' header.`);
            return;
        }
        //Extract client sid
        const clientSessionId = `${x_cryo_sid}`;
        //Trim "Bearer" from "Bearer ..."
        const clientBearerToken = authorization.slice(7);
        //Authenticate the extracted bearer token to the supplied "tokenValidator" function
        const isTokenValid = await this.tokenValidator.validate(clientBearerToken);
        if (!isTokenValid) {
            this.__denyAndDestroy(socket, `Upgrade request for ${socketFmt} was refused. Invalid bearer token in authorization query.`);
            return;
        }
        this.log(`Upgrade request from ${socketFmt} was accepted.`);
        //Let the ws server handle the upgrade...
        this.ws_server.handleUpgrade(request, socket, head, (client, request) => {
            this.log(`Internal WS server completed upgrade for ${socketFmt}.`);
            //Call our callback once it's done
            this.WSUpgradeCallback.call(this, request, socket, client, clientBearerToken, clientSessionId);
        });
    }
    async WSUpgradeCallback(request, socket, client, token, clientSid) {
        //Assert that the socket has an "isAlive" property and if so, cast the "Client" as having this property
        //Additionally, add a "sessionId" property containing a UUIDv4
        Guard.CastAs(client);
        const socketFmt = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
        client.isAlive = true;
        client.sessionId = clientSid;
        const session = new CryoServerWebsocketSession(client, socket, socketFmt, this.backpressure_options);
        this.sessions.push(session);
        this.emit("session", session);
    }
    async Heartbeat() {
        for (const session of this.GetValidClients()) {
            //Assert that the socket has an "isAlive" property and if so, cast the "Client" as having this property
            if (!session.Client.isAlive) {
                this.log(`Terminating dead client session ${session.Client.sessionId}`);
                const sIdx = this.sessions.findIndex(s => s.Client.sessionId === session.Client.sessionId);
                const retrievedSession = this.sessions.splice(sIdx, 1)[0];
                retrievedSession.Destroy();
                return;
            }
            session.Client.isAlive = false;
            await session.Ping();
        }
    }
    GetValidClients() {
        if (!this.ws_server.clients)
            return [];
        if (this.ws_server.clients.size === 0)
            return [];
        return this.sessions;
    }
    /*
    * Teardown this server and all sessions, terminate all connections
    * */
    Destroy() {
        this.server.removeAllListeners();
        this.server.close();
        this.WebsocketHearbeatInterval.unref();
        clearInterval(this.WebsocketHearbeatInterval);
        for (const session of this.GetValidClients())
            session.Destroy();
        this.ws_server.removeAllListeners();
        this.ws_server.close();
    }
    get http_server() {
        return this.server;
    }
    get websocket_server() {
        return this.ws_server;
    }
    RegisterExtension(extension) {
        CryoExtensionRegistry.register(extension);
    }
}
