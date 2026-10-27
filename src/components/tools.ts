import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BaselineConfig, RunContext, ToolEntryConfig } from "../types.js";
import { isPlainObject } from "../util/object.js";
import type { MemoryStore } from "./memory.js";

const DEFAULT_BUILTINS = ["read", "bash", "edit", "write"];

export interface ResolvedTools {
  allowlist?: string[];
  customTools: ToolDefinition[];
  definitions: Array<{ name: string; description: string; parameters: unknown; source: string }>;
}

async function customTool(entry: ToolEntryConfig, ctx: RunContext): Promise<ToolDefinition[]> {
  if (!entry.module) throw new Error(`Tool ${entry.name} has no module`);
  const specifier = `${pathToFileURL(entry.module).href}?run=${Date.now()}-${Math.random()}`;
  const module = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  const exported = module[entry.export ?? "default"];
  if (typeof exported !== "function") throw new Error(`Tool module ${entry.module} export ${entry.export ?? "default"} is not a factory`);
  const produced = await exported(ctx, entry.config ?? {});
  return Array.isArray(produced) ? produced as ToolDefinition[] : [produced as ToolDefinition];
}

async function fixtureTool(entry: ToolEntryConfig): Promise<ToolDefinition> {
  if (!entry.fixture) throw new Error(`Fixture tool ${entry.name} has no fixture file`);
  const fixture = JSON.parse(await readFile(entry.fixture, "utf8")) as {
    responses?: Record<string, unknown>;
    default?: unknown;
    error_for?: string[];
  };
  return defineTool({
    name: entry.name,
    label: entry.name,
    description: entry.description ?? `Fixture-backed ${entry.name} tool`,
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
    }),
    execute: async (_callId, params) => {
      const query = params.query ?? "";
      if (fixture.error_for?.includes(query)) throw new Error(`Fixture error for ${query}`);
      const value = fixture.responses?.[query] ?? fixture.default ?? "No fixture response";
      return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], details: { fixture: entry.fixture } };
    },
  });
}

function memoryTool(entry: ToolEntryConfig, memory: MemoryStore): ToolDefinition {
  return defineTool({
    name: entry.name,
    label: entry.name,
    description: entry.description ?? "Search or update the experiment memory store",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("search"), Type.Literal("list"), Type.Literal("write"), Type.Literal("delete")])),
      query: Type.Optional(Type.String()),
      id: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
    }),
    execute: async (_callId, params) => {
      const action = params.action ?? "search";
      if (action === "write") {
        if (!params.id || params.content === undefined) throw new Error("write requires id and content");
        await memory.mutate("write", { id: params.id, content: params.content });
        return { content: [{ type: "text", text: `Wrote memory ${params.id}` }], details: { count: 0 } };
      }
      if (action === "delete") {
        if (!params.id) throw new Error("delete requires id");
        await memory.mutate("delete", { id: params.id });
        return { content: [{ type: "text", text: `Deleted memory ${params.id}` }], details: { count: 0 } };
      }
      const { selection, rendered } = await memory.retrieveWithSelection({ conversation: [], ...(params.query !== undefined ? { query: params.query } : {}) });
      return { content: [{ type: "text", text: rendered.text }], details: { count: selection.records.length } };
    },
  });
}

export async function buildToolRegistry(
  config: BaselineConfig,
  ctx: RunContext,
  memory?: MemoryStore,
): Promise<ResolvedTools> {
  const registry = config.tools;
  if (registry.mode === "pi-default") {
    return {
      customTools: [],
      definitions: DEFAULT_BUILTINS.map((name) => ({ name, description: "Pi built-in", parameters: {}, source: "pi-builtin" })),
    };
  }

  const allowlist = registry.mode === "replace"
    ? []
    : DEFAULT_BUILTINS.filter((name) => !(registry.remove ?? []).includes(name));
  const customTools: ToolDefinition[] = [];
  const definitions: ResolvedTools["definitions"] = allowlist.map((name) => ({ name, description: "Pi built-in", parameters: {}, source: "pi-builtin" }));

  for (const entry of registry.entries ?? []) {
    if (entry.source === "pi-builtin") {
      const name = entry.builtin ?? entry.name;
      if (!allowlist.includes(name)) allowlist.push(name);
      if (!definitions.some((item) => item.name === name)) definitions.push({ name, description: "Pi built-in", parameters: {}, source: "pi-builtin" });
      continue;
    }
    const built = entry.source === "custom"
      ? await customTool(entry, ctx)
      : entry.source === "fixture"
        ? [await fixtureTool(entry)]
        : memory
          ? [memoryTool(entry, memory)]
          : (() => { throw new Error(`Memory tool ${entry.name} has no memory store`); })();
    for (const tool of built) {
      const existing = customTools.findIndex((candidate) => candidate.name === tool.name);
      if (existing >= 0) customTools.splice(existing, 1, tool);
      else customTools.push(tool);
      if (!allowlist.includes(tool.name)) allowlist.push(tool.name);
      const recordedDefinition = {
        name: tool.name,
        description: tool.description,
        parameters: isPlainObject(tool.parameters) ? tool.parameters : tool.parameters,
        source: entry.source,
      };
      const definitionIndex = definitions.findIndex((item) => item.name === tool.name);
      if (definitionIndex >= 0) definitions.splice(definitionIndex, 1, recordedDefinition);
      else definitions.push(recordedDefinition);
    }
  }
  return { allowlist, customTools, definitions };
}
