import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RunRecorder } from "../src/recording/recorder.js";
import { temporaryDirectory } from "./helpers.js";

describe("recording contract", () => {
  it("preserves retry, compaction, cancellation, and limit events distinctly with monotonic sequences", async () => {
    const root = await temporaryDirectory("trace-recorder-");
    const recorder = new RunRecorder(root, {
      run_id: "run",
      condition_id: "condition",
      scenario_id: "scenario",
      repetition: 1,
      seed: 1,
    });
    await recorder.initialize({});
    for (const type of ["auto_retry_start", "compaction_start", "cancellation", "limit_reached"]) await recorder.record(type);
    await recorder.flush();
    const lines = (await readFile(path.join(root, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(["auto_retry_start", "compaction_start", "cancellation", "limit_reached"]);
    expect(lines.map((line) => line.sequence)).toEqual([1, 2, 3, 4]);
  });
});
