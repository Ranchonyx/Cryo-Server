import {Express} from "express";
import {ITokenValidator} from "./CryoWebsocketServer/types/ITokenValidator.js";
import {CryoWebsocketServerOptions} from "./CryoWebsocketServer/types/CryoWebsocketServer.js";
import {CryoWebsocketServer} from "./CryoWebsocketServer/CryoWebsocketServer.js";

/**
 * Create a Cryo server and attach it to an Express.js app
 * @param pApp - The express app to attach the server to
 * @param pTokenValidator - An implementation of the {@link ITokenValidator} interface to validate incoming websocket connections
 * @param options - Optional arguments, {@link CryoWebsocketServerOptions}
 * */
export async function cryo(pApp: Express, pTokenValidator: ITokenValidator, options?: CryoWebsocketServerOptions) {
    return CryoWebsocketServer.AttachToApp(pApp, pTokenValidator, options);
}