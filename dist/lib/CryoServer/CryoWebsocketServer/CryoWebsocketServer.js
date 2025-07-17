import http from "node:http";
import { json, urlencoded } from "express";
import { randomBytes } from "node:crypto";
import session, { MemoryStore } from "express-session";
import { WebSocketServer } from "ws";
import { clearInterval, setInterval } from "node:timers";
import { EventEmitter } from "node:events";
import Guard from "../../Common/Util/Guard.js";
import { CryoServerWebsocketSession } from "../CryoServerWebsocketSession/CryoServerWebsocketSession.js";
import { CreateDebugLogger } from "../../Common/Util/CreateDebugLogger.js";
export class CryoWebsocketServer extends EventEmitter {
    expressApp;
    server;
    tokenValidator;
    sessionParser;
    wsServer;
    WebsocketHearbeatInterval;
    sessions = [];
    log;
    /*
    * Attach a CryoWebsocketServer to an express.JS app
    * */
    static async AttachToApp(pApp, pTokenValidator, options) {
        const secret = options && options.secretGenerator ? await options.secretGenerator.generate() : randomBytes(512).toString("hex");
        const genid = options && options.sessionIDGenerator ? options.sessionIDGenerator.generate.bind(options.sessionIDGenerator) : undefined;
        const store = options && options.sessionStore || new MemoryStore();
        const keepAliveInterval = options && options.keepAliveIntervalMs || 15000;
        const sockPort = options && options.port || 8080;
        const server = http.createServer(pApp);
        const sessionParser = session({
            secret: secret,
            store: store,
            genid: genid,
            resave: true,
            saveUninitialized: false,
            cookie: {
                secure: "auto",
                maxAge: 90000
            }
        });
        return new CryoWebsocketServer(pApp, server, pTokenValidator, sessionParser, keepAliveInterval, sockPort);
    }
    constructor(expressApp, server, tokenValidator, sessionParser, keepAliveInterval, socketPort) {
        super();
        this.expressApp = expressApp;
        this.server = server;
        this.tokenValidator = tokenValidator;
        this.sessionParser = sessionParser;
        this.log = CreateDebugLogger("CRYO_SERVER");
        this.expressApp.use(json(), this.sessionParser, urlencoded({ extended: true }));
        this.wsServer = new WebSocketServer({ noServer: true });
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
        const authorization = request.headers.authorization;
        const x_cryo_sid = request.headers["x-cryo-sid"];
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
            this.__denyAndDestroy(socket, `Upgrade request for ${socketFmt} was refused. Invalid bearer token in header.`);
            return;
        }
        this.log(`Upgrade request from ${socketFmt} was accepted.`);
        //Let the ws server handle the upgrade...
        this.wsServer.handleUpgrade(request, socket, head, (client, request) => {
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
        /*
                await this.databaseAccessor.set(clientSid, "sid", clientSid);
        */
        const session = new CryoServerWebsocketSession(token, client, socket, request, socketFmt);
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
            await session.SendPing();
        }
    }
    GetValidClients() {
        if (!this.wsServer.clients)
            return [];
        if (this.wsServer.clients.size === 0)
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
        this.wsServer.removeAllListeners();
        this.wsServer.close();
    }
    get app() {
        return this.expressApp;
    }
    get socketServer() {
        return this.wsServer;
    }
}
