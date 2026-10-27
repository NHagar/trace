import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  JsonObject,
  MemoryConfig,
  MemoryRecord,
  MemoryRenderer,
  MemoryRetriever,
  MemorySelection,
  RenderedMemory,
  RetrievalInput,
  RunContext,
} from "../types.js";
import { isPlainObject } from "../util/object.js";
import { stableStringify } from "../util/object.js";
import { isWithinDirectory, pathExists, resolveWorkspacePath } from "../util/fs.js";

function assertRecords(value: unknown, source: string): MemoryRecord[] {
  const values = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.records)
      ? value.records
      : [value];
  return values.map((item, index) => {
    if (!isPlainObject(item) || typeof item.id !== "string" || typeof item.content !== "string") {
      throw new Error(`Invalid memory record at ${source}[${index}]; expected {id, content, metadata?}`);
    }
    return {
      id: item.id,
      content: item.content,
      ...(isPlainObject(item.metadata) ? { metadata: item.metadata as JsonObject } : {}),
      source,
    };
  });
}

async function loadRecords(contentsPath: string, parseJson = true): Promise<MemoryRecord[]> {
  const info = await stat(contentsPath);
  if (info.isDirectory()) {
    const records: MemoryRecord[] = [];
    for (const name of (await readdir(contentsPath)).sort()) {
      const filePath = path.join(contentsPath, name);
      records.push(...(await loadRecords(filePath, parseJson)));
    }
    return records;
  }
  const content = await readFile(contentsPath, "utf8");
  if (parseJson && contentsPath.endsWith(".json")) return assertRecords(JSON.parse(content), contentsPath);
  return [{ id: path.basename(contentsPath).replace(/\.[^.]+$/, ""), content, source: contentsPath }];
}

async function loadExport(modulePath: string, exportName = "default"): Promise<unknown> {
  const specifier = `${pathToFileURL(modulePath).href}?run=${Date.now()}-${Math.random()}`;
  const module = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
  if (!(exportName in module)) throw new Error(`Module ${modulePath} has no export ${exportName}`);
  return module[exportName];
}

export class MemoryStore {
  private records: MemoryRecord[] = [];
  private initialRecords: MemoryRecord[] = [];
  private fileDestination: string | undefined;
  private materializedRecords: MemoryRecord[] = [];
  private retrieverValue: Promise<MemoryRetriever> | undefined;
  private rendererValue: Promise<MemoryRenderer> | undefined;

  constructor(
    readonly config: MemoryConfig,
    private readonly ctx: RunContext,
    private readonly onFailure?: (error: unknown) => void,
  ) {}

  async initialize(): Promise<void> {
    if (!this.config.contents) throw new Error("Memory contents are not configured");
    this.initialRecords = await loadRecords(this.config.contents);
    this.records = structuredClone(this.initialRecords);
    await this.ctx.record("memory_initialized", { records: this.records });
  }

  async reset(): Promise<void> {
    this.records = structuredClone(this.initialRecords);
    await this.ctx.record("memory_reset", { records: this.records });
  }

  snapshot(): MemoryRecord[] {
    return structuredClone(this.records);
  }

  async mutate(action: "write" | "delete", record: MemoryRecord | { id: string }): Promise<void> {
    if (this.config.mutability !== "writable") throw new Error("Memory is read-only");
    const before = this.snapshot();
    if (action === "delete") this.records = this.records.filter((item) => item.id !== record.id);
    else {
      const index = this.records.findIndex((item) => item.id === record.id);
      if (index >= 0) this.records[index] = structuredClone(record as MemoryRecord);
      else this.records.push(structuredClone(record as MemoryRecord));
    }
    await this.ctx.record("memory_mutation", { action, before, after: this.snapshot() });
  }

  private async retriever(): Promise<MemoryRetriever> {
    const strategy = this.config.retrieval ?? { type: "all" as const };
    if (strategy.type === "all") {
      return { retrieve: async () => ({ records: this.snapshot() }) };
    }
    const exported = await loadExport(strategy.module, strategy.export);
    if (typeof exported === "function") {
      if (strategy.factory) {
        const candidate = await exported(strategy.config ?? {});
        if (candidate && typeof candidate.retrieve === "function") return candidate as MemoryRetriever;
        throw new Error(`Custom retriever factory ${strategy.module} must return an object implementing retrieve()`);
      }
      return { retrieve: exported as MemoryRetriever["retrieve"] };
    }
    if (isPlainObject(exported) && typeof exported.retrieve === "function") return exported as unknown as MemoryRetriever;
    throw new Error(`Custom retriever ${strategy.module} does not implement retrieve()`);
  }

  private async renderer(): Promise<MemoryRenderer> {
    const strategy = this.config.representation ?? { type: "verbatim" as const };
    if (strategy.type === "custom") {
      const exported = await loadExport(strategy.module, strategy.export);
      if (typeof exported === "function") {
        if (strategy.factory) {
          const candidate = await exported(strategy.config ?? {});
          if (candidate && typeof candidate.render === "function") return candidate as MemoryRenderer;
          throw new Error(`Custom renderer factory ${strategy.module} must return an object implementing render()`);
        }
        return { render: exported as MemoryRenderer["render"] };
      }
      if (isPlainObject(exported) && typeof exported.render === "function") return exported as unknown as MemoryRenderer;
      throw new Error(`Custom renderer ${strategy.module} does not implement render()`);
    }
    if (strategy.type === "json-records") {
      return { render: async (selection) => ({ text: JSON.stringify(selection.records, null, 2) }) };
    }
    if (strategy.type === "markdown-records") {
      return {
        render: async (selection) => ({
          text: selection.records.map((record) => `## ${record.id}\n\n${record.content}`).join("\n\n"),
        }),
      };
    }
    return { render: async (selection) => ({ text: selection.records.map((record) => record.content).join("\n\n") }) };
  }

  async retrieve(input: RetrievalInput): Promise<RenderedMemory> {
    return (await this.retrieveWithSelection(input)).rendered;
  }

  async retrieveWithSelection(input: RetrievalInput): Promise<{ selection: MemorySelection; rendered: RenderedMemory }> {
    try {
      this.ctx.signal.throwIfAborted();
      const selection = await (await (this.retrieverValue ??= this.retriever())).retrieve(input, this.ctx);
      this.ctx.signal.throwIfAborted();
      if (!selection || !Array.isArray(selection.records)) throw new Error("Memory retriever must return {records: [...]}");
      await this.ctx.record("memory_selection", { input, selection });
      const rendered = await (await (this.rendererValue ??= this.renderer())).render(selection, this.ctx);
      this.ctx.signal.throwIfAborted();
      if (!rendered || typeof rendered.text !== "string") throw new Error("Memory renderer must return {text: string}");
      await this.ctx.record("memory_rendered", { rendered });
      return { selection, rendered };
    } catch (error) {
      this.onFailure?.(error);
      throw error;
    }
  }

  async materializeFiles(input: RetrievalInput = { conversation: [] }): Promise<void> {
    if (this.config.delivery?.type !== "files" || !this.config.contents) return;
    const destination = await resolveWorkspacePath(this.ctx.workspace, this.config.delivery.destination ?? "memory");
    const rendered = await this.retrieve(input);
    const representation = this.config.representation?.type ?? "verbatim";
    const filename = representation === "json-records" ? "memory.json"
      : representation === "verbatim" && (await stat(this.config.contents)).isFile() && !this.config.contents.endsWith(".json")
        ? path.basename(this.config.contents) : "memory.md";
    const files = rendered.files ?? [{ path: filename, content: rendered.text }];
    const targets = await Promise.all(files.map(async (file) => {
      const target = path.resolve(destination, file.path);
      if (path.isAbsolute(file.path) || !isWithinDirectory(destination, target)) throw new Error(`Rendered memory file escapes its destination: ${file.path}`);
      await resolveWorkspacePath(this.ctx.workspace, path.relative(this.ctx.workspace, target));
      return { target, content: file.content };
    }));
    this.ctx.signal.throwIfAborted();
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    for (const file of targets) {
      await mkdir(path.dirname(file.target), { recursive: true });
      await writeFile(file.target, file.content, "utf8");
      if (this.config.mutability === "read-only") await chmod(file.target, 0o444);
    }
    this.fileDestination = destination;
    this.materializedRecords = await loadRecords(destination, false);
    await this.ctx.record("memory_files_materialized", { destination });
  }

  async captureFileMutations(): Promise<void> {
    if (this.config.delivery?.type !== "files" || !this.fileDestination) return;
    const finalRecords = await pathExists(this.fileDestination) ? await loadRecords(this.fileDestination, false) : [];
    if (stableStringify(finalRecords) !== stableStringify(this.materializedRecords)) {
      const before = this.snapshot();
      this.records = finalRecords;
      this.materializedRecords = structuredClone(finalRecords);
      await this.ctx.record("memory_mutation", { action: "files_changed", before, after: this.snapshot() });
    }
  }

  async persistWritableState(target: string): Promise<void> {
    if (this.config.mutability !== "writable") return;
    await writeFile(target, `${JSON.stringify({ records: this.records }, null, 2)}\n`, "utf8");
  }
}

export function memoryEnvelope(rendered: RenderedMemory): string {
  return `<experiment-memory>\n${rendered.text}\n</experiment-memory>`;
}

export async function retrieveMemory(
  store: MemoryStore,
  conversation: unknown[],
  options: { query?: string; step_id?: string } = {},
): Promise<{ selection: MemorySelection; rendered: RenderedMemory }> {
  return store.retrieveWithSelection({ conversation, ...options });
}
