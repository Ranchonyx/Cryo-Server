import {UUID} from "node:crypto";

export interface ICryoServerWebsocketSessionEvents {
    "message-utf8": (message: string) => Promise<void>;
    "message-binary": (message: Buffer) => Promise<void>;

    "closed": () => void;
}

export type CryoWebsocketSessionDefaultMetadata = {
    sid: UUID;
};

type FromToType = "local" | "remote";
export type CryoSessionHistoryEntry = {
    data: Buffer | string;
    from: FromToType;
    to: FromToType;
}