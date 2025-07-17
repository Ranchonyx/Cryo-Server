import {CryoWebsocketSessionDefaultMetadata} from "../../CryoServerWebsocketSession/types/CryoWebsocketSession.js";
import {UUID} from "node:crypto";

export interface IDatabaseAccessor<T extends {} = {}> {
    get<K = keyof (T & CryoWebsocketSessionDefaultMetadata)>(sid: UUID, key: K): Promise<(T & CryoWebsocketSessionDefaultMetadata)[K]>;

    set<K = keyof (T & CryoWebsocketSessionDefaultMetadata)>(sid: UUID, key: K, value: (T & CryoWebsocketSessionDefaultMetadata)[K]): Promise<void>;

    has<K = keyof (T & CryoWebsocketSessionDefaultMetadata)>(sid: UUID, key: K): Promise<boolean>;
}

export interface IDatabaseAccessorConstructor {
    new(id: UUID): IDatabaseAccessor;
}