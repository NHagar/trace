import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPlan } from "../dist/execution/scheduler.js";
import { planExperiment } from "../src/planner/plan.js";
import { basicProject, temporaryDirectory, writeFiles } from "./helpers.js";

describe("execution output isolation", () => {
  it("rejects reruns into existing results without changing prior records", async () => {
    const plan = (await planExperiment(await basicProject())).plan!;
    const output = await temporaryDirectory("agent-study-output-reuse-");
    const first = await runPlan(plan, { output });
    expect(first.exitCode).toBe(0);
    const eventsPath = path.join(output, "runs", plan.runs[0]!.run_id, "events.jsonl");
    const previous = await readFile(eventsPath, "utf8");
    await expect(runPlan(plan, { output })).rejects.toThrow("Output directory must be empty");
    expect(await readFile(eventsPath, "utf8")).toBe(previous);
    const differentPlan = (await planExperiment(plan.root)).plan!;
    await expect(runPlan(differentPlan, { output })).rejects.toThrow("Output directory must be empty");
  });

  it("allows only one scheduler to claim an empty output directory", async () => {
    const plan = (await planExperiment(await basicProject())).plan!;
    const output = await temporaryDirectory("agent-study-output-race-");
    const results = await Promise.allSettled([runPlan(plan, { output }), runPlan(plan, { output })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("preserves unrelated files when refusing a nonempty output directory", async () => {
    const plan = (await planExperiment(await basicProject())).plan!;
    const output = await temporaryDirectory("agent-study-output-nonempty-");
    await writeFiles(output, { "keep.txt": "keep" });
    await expect(runPlan(plan, { output })).rejects.toThrow("Output directory must be empty");
    expect(await readFile(path.join(output, "keep.txt"), "utf8")).toBe("keep");
  });
});
