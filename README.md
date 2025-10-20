# Cryo-Server

#### Part of the Cryo Ecosystem

```
 █████ ██████  ██   ██  █████  
██     ██   ██  ██ ██  ██   ██ 
██     ██████    ███   ██   ██ 
██     ██ ██     ██    ██   ██ 
██     ██  ██    ██    ██   ██ 
 █████ ██   ██   ██     █████  
                Server implementation
```

---

## Cryo / Overview

Cryo is a lightweight, efficient Websocket framework intended for building real-time systems

Client implementations are available for:

- **TypeScript / JavaScript** under **Node.Js**
- **TypeScript / JavaScript** under **modern Browsers**
- **C#** under **.NET 8.0**

A server implementation is available for **TypeScript / JavaScript** under **Node.Js**

## Cryo-Server / Overview

The Cryo-Server takes care of the following:

- Client session authentication
- Client session lifecycle management
- Correct framing and structuring of received and sent data

The Cryo-Server provides a public API for creating and destroying an instance.
It provides access to sessions for communication purposes via events

The Cryo-Server is extensible via its **Extension** interface. As such it is possible to, for example, implement an RPC
server.

## Setup

To set up a Cryo Server, simply import the ``cryo`` function from the ``cryo-server`` package.

The ``cryo``-function takes two arguments:

- a required ITokenValidator object
- an optional ICryoWebsocketServerOptions object

## Configuration

### ITokenValidator

```typescript
interface ITokenValidator {
    validate(token: string): Promise<boolean>;
}
```

This interface describes how the server will authenticate incoming connections.

Cryo-Clients send a ``token``, which you may validate in the ``validate``-function.

### ICryoWebsocketServerOptions

```typescript
interface ICryoWebsocketServerOptions {
    keepAliveIntervalMs?: number;
    port?: number;
    use_cale: boolean;
    ssl?: {
        key: Buffer;
        cert: Buffer;
    };
    backpressure?: {
        highWaterMark?: number;
        lowWaterMark?: number;
        maxQueuedBytes?: number;
        maxQueueCount?: number;
        dropPolicy?: "drop-oldest" | "drop-newest" | "dedupe-latest";
    };
}
```

This interface describes various configuration options for the CryoServer:

- keepAliveIntervalMs
    - The frequency in which the server will send application-level pings to the clients, by default ``15000`` is chosen
- port
    - The local port to listen on, by default ``8080`` is chosen
- use_cale
    - If the Server should use ``CALE``, see [CALE](#cale---cryo-application-level-encryption)

In the ``ssl`` object, you may set a `key` and a `cert` to enable SSL connections.

### Backpressure

The backpressure object allows to you control how the Cryo server handles high load and prevents memory bloating

| Option           | Type                                                | Default            | Description                                                                  |
|------------------|-----------------------------------------------------|--------------------|------------------------------------------------------------------------------|
| `highWaterMark`  | `number`                                            | `16 * 1024 * 1024` | Maximum number of bytes allowed in the send buffer before throttling starts. |
| `lowWaterMark`   | `number`                                            | `1024 * 1024`      | Once buffer usage drops below this, sending resumes.                         |
| `maxQueuedBytes` | `number`                                            | `8 * 1024 * 1024`  | Hard cap on total queued bytes. Frames beyond this are dropped.              |
| `maxQueueCount`  | `number`                                            | `1024`             | Hard cap on number of queued frames.                                         |
| `dropPolicy`     | `"drop-oldest" \| "drop-newest" \| "dedupe-latest"` | `"drop-oldest"`    | Strategy used when the queue is full.                                        |

### Drop policies

- drop-oldest
    - Keeps new data, discards the oldest frames first
- drop-newest
    - Keeps old data, discards the newest frame attempting to be sent
- dedupe-latest
    - If a frame of the same type or payload is already queued, replace it instead adding a duplicate

### Public methods

| Name              | Parameter      | Description                                 | Returns |
|-------------------|----------------|---------------------------------------------|---------|
| RegisterExtension | ICryoExtension | Registers a server-side cryo extension      |         |
| Destroy           |                | Closes the server and destroys all sessions |         |

## Cryo-Server / Example

```typescript
import {cryo} from "cryo-server";

const PORT = 8080;
const server = await cryo({
    async validate(token: string): Promise<boolean> {
        return token === "MySuperSecretToken";
    }
}, {use_cale: false, port: PORT});

/*
The cryo server emits events as described by the CryoWebsocketServerEvents interface

interface CryoWebsocketServerEvents {
  "session": (session: CryoServerWebsocketSession) => void;

  "listening": () => void;
}

as such, we can react to when the server starts listening and react to new sessions
*/
server.on("session", async session => {
    console.info(`Session ID: ${session.id}`);
});

server.on("listening", () => {
    console.info("Server is listening...");
});
```

## CryoServerWebsocketSession / Overview

### Data Events

These events are emitted when the server-side session receives data from a client-side session

| Name           | Parameter    | Description                                                    |
|----------------|--------------|----------------------------------------------------------------|
| message-utf8   | data: string | Emitted, when the session receives a utf8 text message         |
| message-binary | data: Buffer | Emitted, when the session receives an arbitrary binary message |

### Statistic Events

These events are emitted periodically and serve as a way to implement metrics, monitoring or other such things

| Name             | Parameter    | Description                                                   |
|------------------|--------------|---------------------------------------------------------------|
| stat-rtt         | data: number | EWMA Average in milliseconds between messages-ACK round trips |
| stat-bytes-rx    | data: number | Total bytes received from the client session                  |
| stat-bytes-tx    | data: number | Total bytes sent to the client session                        |
| stat-ack-timeout | data: number | Count of messages that timed out waiting for an ACK           |

### Meta events

This sad category of events is emitted when something about the session changes

| Name   | Parameter | Description                                                |
|--------|-----------|------------------------------------------------------------|
| closed |           | Emitted, when the session closes or was closed by a client |

### Public methods

| Name       | Parameter               | Description                                                       | Returns |
|------------|-------------------------|-------------------------------------------------------------------|---------|
| SendPing   |                         | Sends a ping to the client session                                |         |
| SendUTF8   | data: string            | Sends the passed utf8 text to the client session                  |         |
| SendBinary | data: Buffer            | Sends the passed buffer to the client session                     |         |
| Set        | key: string, value: any | Sets `key` to `value` in the session's custom data store          |         |
| Get        | key: string             | Retrieves the value of `key` from the session's custom data store | any     |
| Destroy    |                         | Closes and destroys the session object                            |         |

## Cryo-Server / Extension interface

The extension interface allows you to modify the behaviour of the cryo server's message lifecycle, **before sending**
and **after receiving** per session.

Extensions can inspect and modify messages, enabling you to do custom behaviour, such as logging, filtering, building
metrics or transforming the payloads.

Extensions are registered using the cryo-server's ``RegisterExtension``-method.

### Interface definition

````typescript
type Box<T> = { value: T };

export interface ICryoExtension {

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
     * Return false to stop event propagation, or true to continue event propagation
     * @param session - The cryo websocket session
     * @param incoming_message - The incoming binary message from the client
     * */
    on_receive_binary?(session: CryoServerWebsocketSession, incoming_message: Box<Buffer>): Promise<boolean>;

    /**
     * Executed after a text message is received from the client, but before the session can emit the `message-utf8` event
     * Return false to stop event propagation, or true to continue event propagation
     * @param session - The cryo websocket session
     * @param incoming_message - The incoming text message from the client
     * */
    on_receive_utf8?(session: CryoServerWebsocketSession, incoming_message: Box<string>): Promise<boolean>;

    /**
     * The unique name of this extension
     * */
    name: string;
}
````

### Diagram

```
             ┌──────────────────────────┐
             │  Outgoing message starts │
             └────────────┬─────────────┘
                          │
                          ▼
           +--------------------------------+
           | before_send_utf8 / binary hooks |
           +--------------------------------+
                          │
                 (Extensions could:)
                 - inspect message
                 - modify message (via Box<T>)
                 - return false to drop it
                          │
                          ▼
               ┌───────────────────────┐
               │   Message is sent     │
               └─────────┬─────────────┘
                         │
                         ▼
         [Network transmission to client]



         [Incoming message from client]
                         │
                         ▼
           +--------------------------------+
           | on_receive_utf8 / binary hooks  |
           +--------------------------------+
                          │
                 (Extensions could:)
                 - inspect message
                 - modify message (via Box<T>)
                 - return false to suppress emit
                          │
                          ▼
             ┌──────────────────────────┐
             │  message-* event emitted │
             │ (to user application)    │
             └──────────────────────────┘

```
### Example extension
This is an exemplary logging extension. It simply logs each incoming and outgoing message
```typescript
import {Box, ICryoExtension} from "./CryoExtension";
import {CryoServerWebsocketSession} from "./CryoServerWebsocketSession";

class LoggerExtension implements ICryoExtension {
  public name = "unique_name_for_logger";

  public async before_send_utf8(session: CryoServerWebsocketSession, outgoing_message: Box<string>) {
    console.log(`Outgoing UTF-8 message: "${outgoing_message.value}"`);
    return true;
  }

  public async before_send_binary(session: CryoServerWebsocketSession, outgoing_message: Box<Buffer>) {
    console.log(`Outgoing binary message: "${outgoing_message.value.toString(16)}"`);
    return true;
  }

  public async on_receive_utf8(session: CryoServerWebsocketSession, incoming_message: Box<string>) {
    console.log(`Incoming UTF-8 message: "${outgoing_message.value}"`);
    return true;
  }

  public async before_send_utf8(session: CryoServerWebsocketSession, incoming_message: Box<Buffer>) {
    console.log(`Incoming binary message: "${outgoing_message.value.toString(16)}"`);
    return true;
  }
}
```


## CALE - Cryo application level encryption

Warning - This feature is unavailable in the C# client

**CALE** is an optional, end-to-end encryption layer for Cryo.

It adds a layer of cryptographic protection on top of WebSockets/TCP, mainly for environments without TLS or custom
setups

**How:**

- It uses **ECDH / P-256** for an ephemeral key exchange
- Derives symmetric session keys using **SHA-256**
- Encrypts frames using **AES-128-GCM**
- Performs a 3-step handshake ``server_hello -> client_hello -> handshake_done``
- Once completed, all frames are encrypted

```` 
+-------------+                                      +-------------+
|   Client    |                                      |   Server    |
+------+------+                                      +------+------+
       |                                                    |
       | 1) server_hello(pub_key_s, sid, ack)               |
       | <------------------------------------------------- |
       |                                                    |
       | 2) client_hello(pub_key_c, sid, ack)               |
       | -------------------------------------------------> |
       |                                                    |
       | 3) handshake_done                                  |
       | <------------------------------------------------- |
       |                                                    |
       | 4) handshake_done (ack)                            |
       | -------------------------------------------------> |
       |                                                    |
+------+------ +                                      +------+------+
| Secure Chan. | <---------- AES-128-GCM ------------>| Secure Chan.|
|  (tx/rx)     |                                      |  (tx/rx)    |
+--------------+                                      +-------------+

````

Session keys are derived as such

```
secret  = ECDH(pub_key_server, priv_key_client)
hash    = SHA256(secret)
rx_key  = hash[0..15]
tx_key  = hash[16..31]
```

After the ``handshake_done``-step, both peers switch into secure mode, meaning that all data frames (`utf8data`,
`binarydata`) will be encrypted using AES-GCM

**Why:**

CALE is not meant to replace TLS, I wouldn't dare.

It is a protocol-level experiment for extra application-layer encryption, primarily for private deployments or custom
setups.

If you are communicating via TLS, you do **not** need **CALE** at all and it is recommended to disable it for
performance reasons.
