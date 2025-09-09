import https from "https";
import http from "node:http";
import {createECDH, UUID} from "node:crypto";
import {WebSocketServer, WebSocket} from "ws"
import {clearInterval, setInterval} from "node:timers";

import {Duplex} from "node:stream";
import {EventEmitter} from "node:events";
import {DebugLoggerFunction} from "node:util";
import {CreateDebugLogger} from "../Common/Util/CreateDebugLogger.js";
import {ITokenValidator} from "./types/ITokenValidator.js";
import {
    CryoWebsocketServerEvents,
    CryoWebsocketServerOptions,
    FilledBackpressureOpts
} from "./types/CryoWebsocketServer.js";
import Guard from "../Common/Util/Guard.js";
import {CryoServerWebsocketSession} from "../CryoServerWebsocketSession/CryoServerWebsocketSession.js";
import {CryoExtension} from "../CryoExtension/CryoExtension.js";
import {CryoExtensionRegistry} from "../CryoExtension/CryoExtensionRegistry.js";
import {OverwriteUnset} from "../Common/Util/OverwriteUnset.js";

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

    public static async Create(pTokenValidator: ITokenValidator, options?: CryoWebsocketServerOptions) {
        const keepAliveInterval = options?.keepAliveIntervalMs ?? 15000;
        const sockPort = options?.port ?? 8080;
        const use_cale = options?.cale ?? true;
        const backpressure = options?.backpressure ?? {};

        const server = options?.ssl && options.ssl.key && options.ssl.cert ? https.createServer(options.ssl) : http.createServer();

        const bpres_opts_filled: FilledBackpressureOpts = OverwriteUnset(backpressure, {
            dropPolicy: "drop-oldest",
            highWaterMark: 16 * 1024 * 1024,
            lowWaterMark: 1024 * 1024,
            maxQueuedBytes: 8 * 1024 * 1024,
            maxQueueCount: 1024
        });

        return new CryoWebsocketServer(server, pTokenValidator, keepAliveInterval, sockPort, bpres_opts_filled, use_cale);
    }

    private constructor(private server: http.Server | https.Server,
                        private tokenValidator: ITokenValidator,
                        keepAliveInterval: number,
                        socketPort: number,
                        private backpressure_options: FilledBackpressureOpts,
                        private use_cale: boolean = true) {

        super();
        this.log = CreateDebugLogger("CRYO_SERVER");

        this.ws_server = new WebSocketServer({noServer: true});
        this.WebsocketHearbeatInterval = setInterval(this.Heartbeat.bind(this), keepAliveInterval)
            .ref();

        this.server.on("upgrade", this.HTTPUpgradeCallback.bind(this));

        this.server.listen(socketPort, () => {
            this.log(`SSL support? ${this.server instanceof https.Server}`);
            this.emit("listening");
        });
    }

    private __denyAndDestroy(pSocket: Duplex, message: string): void {
        const body = `<html lang="de-DE"><body><h1>401 Unauthorized</h1><p>${message}</p></body></html>`;
        const response =
            `HTTP/1.1 401 Unauthorized\r\n` +
            `Content-Type: text/html; charset=utf-8\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            `Connection: close\r\n` +
            `\r\n` +
            body;

        pSocket.write(response, () => {
            pSocket.end(() => {
                this.log(message);
            });
        });
    }

    private async HTTPUpgradeCallback(request: http.IncomingMessage, socket: Duplex, head: Buffer) {
        const socketFmt = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
        this.log(`Upgrade request from ${socketFmt} ...`);

        //Doesn't actuall connect via ws or wss, just there as placeholder so I can construct an URL...
        const full_host_url = new URL(`ws://${process.env.HOST ?? 'localhost'}${request.url!}`);

        const authorization = full_host_url.searchParams.get("authorization");
        const x_cryo_sid = full_host_url.searchParams.get("x-cryo-sid");

        //Check auth header
        if (!authorization) {
            this.__denyAndDestroy(socket, `Upgrade request for ${socketFmt} was refused. No auth data supplied.`);
            return;
        }

        if (!authorization.startsWith("Bearer")) {
            this.__denyAndDestroy(socket, `Upgrade request for ${socketFmt} was refused. No auth data supplied.`);
            return;
        }

        //Check x-cryo-sid header
        if (!x_cryo_sid) {
            this.__denyAndDestroy(socket, `Upgrade request for ${socketFmt} was refused. No SID supplied.`);
            return;
        }

        if (this.sessions.findIndex(s => s.id === x_cryo_sid) > -1) {
            this.__denyAndDestroy(socket, `Upgrade request for ${socketFmt} was refused. The session already exists.`);
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
            this.WSUpgradeCallback(request, socket, client, clientSessionId);
        });
    }

    private async WSUpgradeCallback(request: http.IncomingMessage, socket: Duplex, client: WebSocket, clientSid: UUID) {
        //Assert that the socket has an "isAlive" property and if so, cast the "Client" as having this property
        //Additionally, add a "sessionId" property containing a UUIDv4
        Guard.CastAs<SocketType>(client);
        const socketFmt = `${request.socket.remoteAddress}:${request.socket.remotePort}`;

        client.isAlive = true;
        client.sessionId = clientSid;

        const session = new CryoServerWebsocketSession(client, socket, socketFmt, this.backpressure_options, this.use_cale);
        this.sessions.push(session);

        session.on("closed", () => {
            const s_idx = this.sessions.findIndex(s => s.id === session.id);
            this.sessions.splice(s_idx, 1);
        });

        this.emit("session", session);
    }

    /*
    * Take care of pinging the clients, removing them if they are not responding anymore and doing per session stat & housekeeping
    * */
    private async Heartbeat(): Promise<void> {
        for (const session of this.sessions) {
            //Assert that the socket has an "isAlive" property and if so, cast the "Client" as having this property

            if (!session.Client.isAlive) {
                this.log(`Terminating dead client session ${session.Client.sessionId}`);

                const sIdx = this.sessions.findIndex(s => s.Client.sessionId === session.Client.sessionId);
                const retrievedSession = this.sessions.splice(sIdx, 1)[0];
                retrievedSession.Destroy();

                continue;
            }

            //Also to housekeeping in the ACK tracker of each client
            const session_tracker = session.get_ack_tracker();
            session.emit("stat-ack-timeout", session_tracker.Sweep());
            session.emit("stat-rtt", session_tracker.rtt)
            session.emit("stat-bytes-tx", session.tx);
            session.emit("stat-bytes-rx", session.rx);

            session.Client.isAlive = false;
            await session.Ping();
        }
    }

    /**
     * Teardown this server and all sessions, terminate all connections
     */
    //noinspection JSUnusedGlobalSymbols
    public Destroy() {
        this.server.removeAllListeners();
        this.server.close();

        this.WebsocketHearbeatInterval.unref();
        clearInterval(this.WebsocketHearbeatInterval);

        for (const session of this.sessions)
            session.Destroy();

        this.ws_server.removeAllListeners();
        this.ws_server.close();
    }

    /**
     * Register a server-side cryo extension
     */
    //noinspection JSUnusedGlobalSymbols
    public RegisterExtension(extension: CryoExtension): void {
        CryoExtensionRegistry.register(extension);
    }
}
