import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initializeExperiment } from "../src/cli/init.js";
import { temporaryDirectory } from "./helpers.js";

describe("init", () => {
  it("creates the documented pinned baseline without making it runnable", async () => {
    const root = path.join(await temporaryDirectory(), "experiment");
    const files = await initializeExperiment(root);
    expect(files).toEqual(expect.arrayContaining(["experiment.yaml", "baseline.yaml", "models/example.yaml", "scenarios/example.yaml", "experiment.lock.json"]));
    expect(await readFile(path.join(root, "baseline.yaml"), "utf8")).toContain("pi_version: 0.85.1");
    expect(await readFile(path.join(root, "baseline.yaml"), "utf8")).toContain("provider: CHOOSE_ME");
  });

  it("refuses to overwrite generated files", async () => {
    const root = path.join(await temporaryDirectory(), "experiment");
    await initializeExperiment(root);
    await expect(initializeExperiment(root)).rejects.toThrow("Refusing to overwrite");
  });
});
