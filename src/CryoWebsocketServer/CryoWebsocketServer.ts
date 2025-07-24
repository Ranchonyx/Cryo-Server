import https from "https";
import http from "node:http";
import {UUID} from "node:crypto";
import {WebSocketServer, WebSocket} from "ws"
import {clearInterval, setInterval} from "node:timers";

import {Duplex} from "node:stream";
import {EventEmitter} from "node:events";
import {DebugLoggerFunction} from "node:util";
import {ITokenValidator} from "./types/ITokenValidator.js";
import {CryoWebsocketServerEvents, CryoWebsocketServerOptions} from "./types/CryoWebsocketServer.js";
import Guard from "../Common/Util/Guard.js";
import {CryoServerWebsocketSession} from "../CryoServerWebsocketSession/CryoServerWebsocketSession.js";
import {CreateDebugLogger} from "../Common/Util/CreateDebugLogger.js";

type SocketType = Duplex & { isAlive: boolean, sessionId: UUID };

export interface CryoWebsocketServer {
    on<U extends keyof CryoWebsocketServerEvents>(event: U, listener: CryoWebsocketServerEvents[U]): this;

    emit<U extends keyof CryoWebsocketServerEvents>(event: U, ...args: Parameters<CryoWebsocketServerEvents[U]>): boolean;
}

export class CryoWebsocketServer extends EventEmitter implements CryoWebsocketServer {
    private readonly ws_server: WebSocketServer;
    private readonly WebsocketHearbeatInterval: NodeJS.Timeout;
    private sessions: Array<CryoServerWebsocketSession> = [];
    private readonly log: DebugLoggerFunction;

    public static async AttachToApp(pTokenValidator: ITokenValidator, options?: CryoWebsocketServerOptions) {
        const keepAliveInterval = options && options.keepAliveIntervalMs || 15000;
        const sockPort = options && options.port || 8080;

        const server = http.createServer();

        return new CryoWebsocketServer(server, pTokenValidator, keepAliveInterval, sockPort);
    }

    private constructor(private server: http.Server | https.Server, private tokenValidator: ITokenValidator, keepAliveInterval: number, socketPort: number) {
        super();
        this.log = CreateDebugLogger("CRYO_SERVER");

        this.ws_server = new WebSocketServer({noServer: true});
        this.WebsocketHearbeatInterval = setInterval(this.Heartbeat.bind(this), keepAliveInterval)
            .ref();

        this.server.on("upgrade", this.HTTPUpgradeCallback.bind(this));

        this.server.listen(socketPort, () => {
            this.emit("listening");
        });
    }

    private __denyAndDestroy(pSocket: Duplex, message: string): void {
        const response = `HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n`
        pSocket.write(response, () => {
            pSocket.end(() => {
                this.log(message);
            });
        });
    }

    private async HTTPUpgradeCallback(request: http.IncomingMessage, socket: Duplex, head: Buffer) {
        const socketFmt = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
        this.log(`Upgrade request from ${socketFmt} ...`);

        const full_host_url = new URL(`ws://${process.env.HOST ?? 'localhost'}${request.url!}`);

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
        const clientSessionId = `${x_cryo_sid}` as UUID;

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

    private async WSUpgradeCallback(request: http.IncomingMessage, socket: Duplex, client: WebSocket, token: string, clientSid: UUID) {
        //Assert that the socket has an "isAlive" property and if so, cast the "Client" as having this property
        //Additionally, add a "sessionId" property containing a UUIDv4
        Guard.CastAs<SocketType>(client);
        const socketFmt = `${request.socket.remoteAddress}:${request.socket.remotePort}`;

        client.isAlive = true;
        client.sessionId = clientSid;

        const session = new CryoServerWebsocketSession(token, client, socket, request, socketFmt);

        this.sessions.push(session);

        this.emit("session", session);
    }

    private async Heartbeat(): Promise<void> {
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

    private GetValidClients(): Array<CryoServerWebsocketSession> {
        if (!this.ws_server.clients)
            return [];

        if (this.ws_server.clients.size === 0)
            return [];

        return this.sessions;
    }

    /*
    * Teardown this server and all sessions, terminate all connections
    * */
    public Destroy() {
        this.server.removeAllListeners();
        this.server.close();

        this.WebsocketHearbeatInterval.unref();
        clearInterval(this.WebsocketHearbeatInterval);

        for (const session of this.GetValidClients())
            session.Destroy();

        this.ws_server.removeAllListeners();
        this.ws_server.close();
    }

    public get http_server() {
        return this.server;
    }

    public get websocket_server() {
        return this.ws_server;
    }
}
