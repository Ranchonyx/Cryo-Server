import {CryoServerWebsocketSession} from "../CryoServerWebsocketSession/CryoServerWebsocketSession.js";

type Box<T> = {value: T}
export interface CryoExtension {

    /**
     * Executed before a binary message is sent to the client session
     * @param session - The cryo websocket session
     * @param outgoing_message - The message buffer to be sent to the client
     * */
    before_send_binary?(session: CryoServerWebsocketSession, outgoing_message: Box<Buffer>): Promise<boolean>;

    /**
     * Executed before a text message is sent to the client session
     * @param session - The cryo websocket session
     * @param outgoing_message - The message text to be sent to the client
     * */
    before_send_utf8?(session: CryoServerWebsocketSession, outgoing_message: Box<string>): Promise<boolean>;

    /**
     * Executed after a binary message is received from the client, but before the session can emit the `message-binary` event
     * @param session - The cryo websocket session
     * @param incoming_message - The incoming binary message from the client
     * */
    on_receive_binary?(session: CryoServerWebsocketSession, incoming_message: Box<Buffer>): Promise<boolean>;

    /**
     * Executed after a text message is received from the client, but before the session can emit the `message-utf8` event
     * @param session - The cryo websocket session
     * @param incoming_message - The incoming text message from the client
     * */
    on_receive_utf8?(session: CryoServerWebsocketSession, incoming_message: Box<string>): Promise<boolean>;

    /**
     * The unique name of this extension
     * */
    name: string;
}