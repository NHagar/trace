import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/components/memory.js";
import { buildToolRegistry } from "../src/components/tools.js";
import type { BaselineConfig, MemoryConfig, RunContext } from "../src/types.js";
import { temporaryDirectory, writeFiles } from "./helpers.js";

async function memoryFixture(config: Partial<MemoryConfig> = {}) {
  const root = await temporaryDirectory("agent-study-memory-");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFiles(root, { "source.md": "unfiltered source", "outside/keep.txt": "keep", "workspace/keep.txt": "keep" });
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const ctx: RunContext = {
    identity: { execution_id: "execution", run_id: "run", condition_id: "condition", scenario_id: "scenario", repetition: 1, seed: 1 },
    experiment_root: root, workspace, random: () => 0.5, signal: new AbortController().signal,
    record: async (type, data = {}) => { events.push({ type, data }); },
    recorded_client: { complete: async () => { throw new Error("Unexpected model request"); } },
  };
  const memory: MemoryConfig = {
    contents: path.join(root, "source.md"), retrieval: { type: "all" }, representation: { type: "verbatim" },
    delivery: { type: "files", destination: "memory" }, mutability: "read-only", ...config,
  };
  return { root, ctx, memory, events };
}

describe("memory delivery safety and strategies", () => {
  it("rejects root, traversal, absolute, and symlink destinations before deleting files", async () => {
    const { root, ctx, memory } = await memoryFixture();
    await symlink(path.join(root, "outside"), path.join(ctx.workspace, "link"));
    for (const destination of [".", "..", "../outside", path.join(root, "outside"), "link", "link/nested"]) {
      const store = new MemoryStore({ ...memory, delivery: { type: "files", destination } }, ctx);
      await store.initialize();
      await expect(store.materializeFiles()).rejects.toThrow(/inside the workspace|symlink/);
      expect(await readFile(path.join(root, "outside", "keep.txt"), "utf8")).toBe("keep");
      expect(await readFile(path.join(ctx.workspace, "keep.txt"), "utf8")).toBe("keep");
    }
  });

  it("calls direct strategy functions with their real input and context", async () => {
    const { root, ctx, memory, events } = await memoryFixture();
    await writeFiles(root, {
      "retrieve.mjs": `export default async (input, ctx) => { await ctx.record("retrieved", {query: input.query}); return {records:[{id:"selected",content:input.query}]}; };`,
      "render.mjs": `export default async (selection, ctx) => { await ctx.record("rendered"); return {text:selection.records[0].content.toUpperCase()}; };`,
    });
    const store = new MemoryStore({ ...memory,
      retrieval: { type: "custom", module: path.join(root, "retrieve.mjs") },
      representation: { type: "custom", module: path.join(root, "render.mjs") },
    }, ctx);
    await store.initialize();
    expect(await store.retrieve({ conversation: [], query: "selected" })).toEqual({ text: "SELECTED" });
    expect(events.filter((event) => event.type === "retrieved")).toEqual([{ type: "retrieved", data: { query: "selected" } }]);
    expect(events.filter((event) => event.type === "rendered")).toHaveLength(1);
  });

  it("instantiates explicitly declared factories once and passes their configuration", async () => {
    const { root, ctx, memory } = await memoryFixture();
    await writeFiles(root, {
      "retrieve.mjs": `export default config => { let count = 0; return {async retrieve() {return {records:[{id:"selected",content:config.prefix + ++count}]};}}; };`,
      "render.mjs": `export default config => ({async render(selection) {return {text:config.prefix + selection.records[0].content};}});`,
    });
    const store = new MemoryStore({ ...memory,
      retrieval: { type: "custom", module: path.join(root, "retrieve.mjs"), factory: true, config: { prefix: "value-" } },
      representation: { type: "custom", module: path.join(root, "render.mjs"), factory: true, config: { prefix: "rendered-" } },
    }, ctx);
    await store.initialize();
    expect((await store.retrieve({ conversation: [] })).text).toBe("rendered-value-1");
    expect((await store.retrieve({ conversation: [] })).text).toBe("rendered-value-2");
  });

  it("applies retrieval and representation to memory tool results", async () => {
    const { root, ctx, memory } = await memoryFixture({ delivery: { type: "tool", name: "memory_search" } });
    await writeFiles(root, {
      "retrieve.mjs": `export default {async retrieve(input) {return {records:[{id:"selected",content:input.query}]};}};`,
      "render.mjs": `export default {async render(selection) {return {text:"Only " + selection.records[0].content};}};`,
    });
    const store = new MemoryStore({ ...memory,
      retrieval: { type: "custom", module: path.join(root, "retrieve.mjs") },
      representation: { type: "custom", module: path.join(root, "render.mjs") },
    }, ctx);
    await store.initialize();
    const registry = await buildToolRegistry({ tools: { mode: "replace", entries: [{ name: "memory_search", source: "memory" }] } } as BaselineConfig, ctx, store);
    const result = await registry.customTools[0]!.execute("call", { query: "chosen" }, undefined, undefined, {} as never);
    expect(result.content).toEqual([{ type: "text", text: "Only chosen" }]);
    expect(result.details).toEqual({ count: 1 });
  });

  it("materializes selected, rendered files and preserves the original memory when files are unchanged", async () => {
    const { root, ctx, memory, events } = await memoryFixture();
    await writeFiles(root, {
      "retrieve.mjs": `export default {async retrieve() {return {records:[{id:"chosen",content:"selected"}]};}};`,
      "render.mjs": `export default {async render(selection) {return {text:"unused fallback",files:[{path:"nested/config.json",content:JSON.stringify({chosen:selection.records[0].content})}]};}};`,
    });
    const store = new MemoryStore({ ...memory,
      retrieval: { type: "custom", module: path.join(root, "retrieve.mjs") },
      representation: { type: "custom", module: path.join(root, "render.mjs") },
    }, ctx);
    await store.initialize();
    await store.materializeFiles();
    expect(await readFile(path.join(ctx.workspace, "memory/nested/config.json"), "utf8")).toBe('{"chosen":"selected"}');
    await expect(readFile(path.join(ctx.workspace, "memory/source.md"))).rejects.toThrow();
    await store.captureFileMutations();
    expect(events.filter((event) => event.type === "memory_mutation")).toHaveLength(0);
    expect(store.snapshot()[0]!.content).toBe("unfiltered source");
  });

  it("rejects rendered file traversal before replacing the destination", async () => {
    const { root, ctx, memory } = await memoryFixture();
    await writeFiles(root, {
      "workspace/memory/keep.txt": "keep",
      "render.mjs": `export default {async render() {return {text:"",files:[{path:"../../outside/keep.txt",content:"destroyed"}]};}};`,
    });
    const store = new MemoryStore({ ...memory, representation: { type: "custom", module: path.join(root, "render.mjs") } }, ctx);
    await store.initialize();
    await expect(store.materializeFiles()).rejects.toThrow(/escapes/);
    expect(await readFile(path.join(root, "outside/keep.txt"), "utf8")).toBe("keep");
    expect(await readFile(path.join(ctx.workspace, "memory/keep.txt"), "utf8")).toBe("keep");
  });

  it("captures file changes once and handles deletion of the memory directory", async () => {
    const { ctx, memory, events } = await memoryFixture({ mutability: "writable" });
    const store = new MemoryStore(memory, ctx);
    await store.initialize();
    await store.materializeFiles();
    await writeFile(path.join(ctx.workspace, "memory/source.md"), "updated");
    await store.captureFileMutations();
    await store.captureFileMutations();
    expect(events.filter((event) => event.type === "memory_mutation")).toHaveLength(1);
    expect(store.snapshot()[0]!.content).toBe("updated");
    await rm(path.join(ctx.workspace, "memory"), { recursive: true });
    await store.captureFileMutations();
    expect(store.snapshot()).toEqual([]);
  });
});
