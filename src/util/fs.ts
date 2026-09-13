import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ContentHash } from "../types.js";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function sha256File(filePath: string): Promise<ContentHash> {
  const content = await readFile(filePath);
  return {
    path: filePath,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: content.length,
  };
}

export async function walkFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const rootStat = await stat(root);
  if (rootStat.isFile()) return [root];
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await walkFiles(child)));
    else if (entry.isFile()) output.push(child);
  }
  return output.sort();
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, "a");
  try {
    await handle.write(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export function resolveFrom(declaringFile: string, referencedPath: string): string {
  return path.resolve(path.dirname(declaringFile), referencedPath);
}
