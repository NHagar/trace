import { cp, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { JsonValue, PlannedRun, RunStatus } from "../types.js";
import { appendJsonLine, atomicWriteJson, sha256File, walkFiles } from "../util/fs.js";
import { redactSecrets } from "../util/object.js";

export interface FileInventoryEntry {
  path: string;
  sha256: string;
  size: number;
}

export async function inventory(root: string): Promise<FileInventoryEntry[]> {
  const entries: FileInventoryEntry[] = [];
  for (const file of await walkFiles(root)) {
    const info = await stat(file);
    if (!info.isFile()) continue;
    const hash = await sha256File(file);
    entries.push({ path: path.relative(root, file), sha256: hash.sha256, size: hash.size });
  }
  return entries;
}

export class RunRecorder {
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly runDirectory: string,
    readonly run: PlannedRun,
  ) {}

  async initialize(config: unknown): Promise<void> {
    await mkdir(path.join(this.runDirectory, "artifacts"), { recursive: true });
    await atomicWriteJson(path.join(this.runDirectory, "config.json"), config);
  }

  record(type: string, data: Record<string, unknown> = {}, stepId?: string): Promise<void> {
    const sequence = ++this.sequence;
    const event = {
      schema_version: 1,
      run_id: this.run.run_id,
      sequence,
      timestamp: new Date().toISOString(),
      type,
      ...(stepId ? { step_id: stepId } : {}),
      ...redactSecrets(data) as Record<string, unknown>,
    };
    this.queue = this.queue.then(() => appendJsonLine(path.join(this.runDirectory, "events.jsonl"), event));
    return this.queue;
  }

  async writeMessages(messages: unknown[]): Promise<void> {
    await this.flush();
    await atomicWriteJson(path.join(this.runDirectory, "messages.json"), redactSecrets(messages));
  }

  async writeWorkspaceManifest(initial: FileInventoryEntry[], final: FileInventoryEntry[]): Promise<void> {
    const initialMap = new Map(initial.map((entry) => [entry.path, entry]));
    const finalMap = new Map(final.map((entry) => [entry.path, entry]));
    const changed = final.filter((entry) => initialMap.get(entry.path)?.sha256 !== entry.sha256);
    const deleted = initial.filter((entry) => !finalMap.has(entry.path));
    await atomicWriteJson(path.join(this.runDirectory, "workspace-manifest.json"), {
      schema_version: 1,
      initial,
      final,
      changed: changed.map((entry) => entry.path),
      deleted: deleted.map((entry) => entry.path),
    });
  }

  async preserveArtifacts(workspace: string, initial: FileInventoryEntry[], final: FileInventoryEntry[]): Promise<void> {
    const initialMap = new Map(initial.map((entry) => [entry.path, entry.sha256]));
    for (const entry of final) {
      if (initialMap.get(entry.path) === entry.sha256) continue;
      const source = path.join(workspace, entry.path);
      const destination = path.join(this.runDirectory, "artifacts", entry.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination);
    }
  }

  async finalize(
    status: RunStatus,
    state: {
      started_at: string;
      model_calls: number;
      memory?: unknown;
      error?: string;
      termination?: string;
    },
  ): Promise<void> {
    await this.flush();
    await atomicWriteJson(path.join(this.runDirectory, "final-state.json"), {
      schema_version: 1,
      run_id: this.run.run_id,
      status,
      ...state,
      finished_at: new Date().toISOString(),
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}

export async function readTextIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
