import { CreateDebugLogger } from "../Common/Util/CreateDebugLogger.js";
const log = CreateDebugLogger("CRYO_EXTENSION");
class CryoExtensionExecutor {
    session;
    constructor(session) {
        this.session = session;
    }
    async execute_if_present(extension, handler_name, message) {
        if (!extension[handler_name])
            return { should_emit: true };
        log(`${extension.name}::${handler_name} is present. Executing with: `, message.value);
        return new Promise((resolve) => {
            ///@ts-expect-error
            extension[handler_name](this.session, message).then(should_emit => {
                return { should_emit };
            }).catch(ex => {
                log(`Call to '${handler_name}' of extension '${extension.name}' threw an error`, ex);
                resolve({ should_emit: true, error: ex });
            });
        });
    }
    async apply_before_send(message) {
        let before_send_result = { should_emit: true };
        log(`Running before_send handler, message: `, message);
        for (const extension of CryoExtensionRegistry.extensions) {
            if (typeof message.value === "string") {
                before_send_result = await this.execute_if_present(extension, "before_send_utf8", message);
            }
            else {
                before_send_result = await this.execute_if_present(extension, "before_send_binary", message);
            }
        }
        log("after before_send handler, before_send_result:", before_send_result);
        return before_send_result;
    }
    async apply_after_receive(message) {
        let after_receive_result = { should_emit: true };
        log(`Running after_receive handler, message: `, message);
        for (const extension of CryoExtensionRegistry.extensions) {
            if (typeof message.value === "string") {
                after_receive_result = await this.execute_if_present(extension, "on_receive_utf8", message);
            }
            else {
                after_receive_result = await this.execute_if_present(extension, "on_receive_binary", message);
            }
        }
        log("after after_receive handler, after_receive_result:", after_receive_result);
        return after_receive_result;
    }
}
//noinspection JSUnusedGlobalSymbols
export class CryoExtensionRegistry {
    static extensions = [];
    static get_executor(session) {
        return new CryoExtensionExecutor(session);
    }
    static register(extension) {
        const maybe_index = this.extensions.findIndex(existing_extension => existing_extension.name === extension.name);
        if (maybe_index >= 0)
            throw new Error(`Extension '${extension.name}' is already registered!`);
        this.extensions.push(extension);
    }
    static unregister(extension) {
        const extension_name = typeof extension === "string" ? extension : extension.name;
        const maybe_index = this.extensions.findIndex(extension => extension.name === extension_name);
        if (maybe_index < 0)
            return;
        log(`Unregisted extension '${this.extensions[maybe_index].name}'`);
        this.extensions.splice(maybe_index, 1);
    }
    static Destroy() {
        for (const extension of CryoExtensionRegistry.extensions) {
            this.unregister(extension);
        }
    }
}
