import {CryoExtension} from "./CryoExtension.js";
import {CryoServerWebsocketSession} from "../CryoServerWebsocketSession/CryoServerWebsocketSession.js";
import {CreateDebugLogger} from "../Common/Util/CreateDebugLogger.js";

type Box<T> = { value: T }


const log = CreateDebugLogger("CRYO_EXTENSION");

class CryoExtensionExecutor {
    public constructor(private session: CryoServerWebsocketSession) {
    }

    private async execute_if_present(extension: CryoExtension, handler_name: Exclude<keyof CryoExtension, "name">, message: Box<Buffer | string>): Promise<boolean> {
        if (extension[handler_name]) {
            log(`${extension.name}::${handler_name} is present. Executing with: `, message.value);
            ///@ts-expect-error
            return extension[handler_name](this.session, message);
        }

        return true;
    }

    public async apply_before_send(message: Box<Buffer | string>): Promise<boolean> {
        let should_emit_event = true;
        log(`Running before_send handler, message: `, message);
        for (const extension of CryoExtensionRegistry.extensions) {
            if (typeof message.value === "string") {
                should_emit_event = await this.execute_if_present(extension, "before_send_utf8", message);
            } else {
                should_emit_event = await this.execute_if_present(extension, "before_send_binary", message);
            }
        }

        log("after before_send handler, should_emit_event:", should_emit_event);
        return should_emit_event;
    }

    public async apply_after_receive(message: Box<Buffer | string>): Promise<boolean> {
        let should_emit_event = true;
        log(`Running after_receive handler, message: `, message);
        for (const extension of CryoExtensionRegistry.extensions) {
            if (typeof message.value === "string") {
                should_emit_event = await this.execute_if_present(extension, "on_receive_utf8", message);
            } else {
                should_emit_event = await this.execute_if_present(extension, "on_receive_binary", message);
            }
        }

        log("after after_receive handler, should_emit_event:", should_emit_event);
        return should_emit_event;
    }
}

export class CryoExtensionRegistry {
    public static extensions: CryoExtension[] = [];

    public static get_executor(session: CryoServerWebsocketSession): CryoExtensionExecutor {
        return new CryoExtensionExecutor(session);
    }

    public static register(extension: CryoExtension): void {
        this.extensions.push(extension);
    }

    public static unregister(extension: string): void;
    public static unregister(extension: CryoExtension): void;
    public static unregister(extension: string | CryoExtension): void {
        const extension_name = typeof extension === "string" ? extension : extension.name;
        const maybe_index = this.extensions.findIndex(extension => extension.name === extension_name);

        if (maybe_index < 0)
            return;

        this.extensions.splice(maybe_index, 1);
    }
}