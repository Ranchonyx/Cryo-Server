import {CryoWebsocketServer} from "./CryoWebsocketServer/CryoWebsocketServer.js";

/**
 * Create a Cryo server
 * @param pTokenValidator - An implementation of the {@link ITokenValidator} interface to validate incoming websocket connections
 * @param options - Optional arguments, {@link ICryoWebsocketServerOptions}
 * */
//noinspection JSUnusedGlobalSymbols
export function cryo(pTokenValidator, options) {
    return CryoWebsocketServer.Create(pTokenValidator, options);
}

process.env.DEBUG = "CRYO_SERVER;CRYO_SERVER_SESSION"
const s1 = await cryo({
    validate(token) {
        console.log(`s1 got ${token}`)
        return true;
    }
}, {port: 4444});

const s2 = await cryo({
    validate(token) {
        console.log(`s2 got ${token}`)
        return true;
    }
}, {port: 4445});

const peerSess = await s1.ConnectPeer("ws://localhost:4444", "meow");

/*
console.log(peerSess);*/

await peerSess.SendUTF8("Hewwo");