import { CryoWebsocketServer } from "./CryoWebsocketServer/CryoWebsocketServer.js";
/**
 * Create a Cryo server
 * @param pTokenValidator - An implementation of the {@link ITokenValidator} interface to validate incoming websocket connections
 * @param options - Optional arguments, {@link ICryoWebsocketServerOptions}
 * */
//noinspection JSUnusedGlobalSymbols
export async function cryo(pTokenValidator, options) {
    return CryoWebsocketServer.Create(pTokenValidator, options);
}
