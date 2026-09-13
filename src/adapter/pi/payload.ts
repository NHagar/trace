import { isPlainObject } from "../../util/object.js";

const SEPARATOR = "\n\n---\n\n";

export function injectSystemMemory(payload: unknown, memory: string): unknown {
  if (!isPlainObject(payload)) return payload;
  const copy = structuredClone(payload);
  if (typeof copy.system === "string") {
    copy.system = `${copy.system}${SEPARATOR}${memory}`;
    return copy;
  }
  if (Array.isArray(copy.system)) {
    copy.system = [...copy.system, { type: "text", text: memory }];
    return copy;
  }
  if (typeof copy.instructions === "string") {
    copy.instructions = `${copy.instructions}${SEPARATOR}${memory}`;
    return copy;
  }
  if (Array.isArray(copy.messages)) {
    const messages = copy.messages as unknown[];
    const index = messages.findIndex((message) => isPlainObject(message) && ["system", "developer"].includes(message.role as string));
    if (index >= 0 && isPlainObject(messages[index])) {
      const message = structuredClone(messages[index]) as Record<string, unknown>;
      message.content = typeof message.content === "string"
        ? `${message.content}${SEPARATOR}${memory}`
        : [...(Array.isArray(message.content) ? message.content : []), { type: "text", text: memory }];
      messages[index] = message;
    } else messages.unshift({ role: "system", content: memory });
    return copy;
  }
  return { ...copy, system: memory };
}
