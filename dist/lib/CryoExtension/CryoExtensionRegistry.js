import { CreateDebugLogger } from "../Common/Util/CreateDebugLogger.js";
const log = CreateDebugLogger("CRYO_EXTENSION");
class CryoExtensionExecutor {
    session;
    constructor(session) {
        this.session = session;
    }
    async execute_if_present(extension, handler_name, message) {
        if (extension[handler_name]) {
            log(`${extension.name}::${handler_name} is present. Executing with: `, message.value);
            ///@ts-expect-error
            return extension[handler_name](this.session, message);
        }
        return true;
    }
    async apply_before_send(message) {
        let should_emit_event = true;
        log(`Running before_send handler, message: `, message);
        for (const extension of CryoExtensionRegistry.extensions) {
            if (typeof message.value === "string") {
                should_emit_event = await this.execute_if_present(extension, "before_send_utf8", message);
            }
            else {
                should_emit_event = await this.execute_if_present(extension, "before_send_binary", message);
            }
        }
        log("after before_send handler, should_emit_event:", should_emit_event);
        return should_emit_event;
    }
    async apply_after_receive(message) {
        let should_emit_event = true;
        log(`Running after_receive handler, message: `, message);
        for (const extension of CryoExtensionRegistry.extensions) {
            if (typeof message.value === "string") {
                should_emit_event = await this.execute_if_present(extension, "on_receive_utf8", message);
            }
            else {
                should_emit_event = await this.execute_if_present(extension, "on_receive_binary", message);
            }
        }
        log("after after_receive handler, should_emit_event:", should_emit_event);
        return should_emit_event;
    }
}
//noinspection JSUnusedGlobalSymbols
export class CryoExtensionRegistry {
    static extensions = [];
    static get_executor(session) {
        return new CryoExtensionExecutor(session);
    }
    static register(extension) {
        this.extensions.push(extension);
    }
    static unregister(extension) {
        const extension_name = typeof extension === "string" ? extension : extension.name;
        const maybe_index = this.extensions.findIndex(extension => extension.name === extension_name);
        if (maybe_index < 0)
            return;
        this.extensions.splice(maybe_index, 1);
    }
}
