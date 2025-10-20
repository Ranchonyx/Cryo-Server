import {ITokenValidator} from "./CryoWebsocketServer/types/ITokenValidator.js";
import {ICryoWebsocketServerOptions} from "./CryoWebsocketServer/types/CryoWebsocketServer.js";
import {CryoWebsocketServer} from "./CryoWebsocketServer/CryoWebsocketServer.js";

/**
 * Create a Cryo server
 * @param pTokenValidator - An implementation of the {@link ITokenValidator} interface to validate incoming websocket connections
 * @param options - Optional arguments, {@link ICryoWebsocketServerOptions}
 * */
//noinspection JSUnusedGlobalSymbols
export async function cryo(pTokenValidator: ITokenValidator, options?: ICryoWebsocketServerOptions) {
    return CryoWebsocketServer.Create(pTokenValidator, options);
}