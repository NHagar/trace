import { fork, type ChildProcess } from "node:child_process";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ExecutionPlan, RunResult, RunStatus } from "../types.js";
import { DiagnosticError } from "../errors.js";
import { atomicWriteJson, pathExists, readJson } from "../util/fs.js";
import { validateSavedPlan } from "../planner/plan.js";
import type { WorkerPayload } from "./worker.js";
import { RunRecorder } from "../recording/recorder.js";

export interface BatchResult {
  output: string;
  results: RunResult[];
  exitCode: number;
}

async function copyAssets(plan: ExecutionPlan, output: string): Promise<void> {
  for (const entry of plan.content_hashes) {
    const source = path.isAbsolute(entry.path) ? entry.path : path.join(plan.root, entry.path);
    const relative = path.isAbsolute(entry.path)
      ? path.join("external", `${entry.sha256.slice(0, 12)}-${path.basename(entry.path)}`)
      : entry.path;
    const destination = path.join(output, "assets", relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
  }
}

function workerPath(): string {
  return fileURLToPath(new URL("./worker.js", import.meta.url));
}

function spawnTrial(payloadPath: string): { child: ChildProcess; done: Promise<RunResult> } {
  const child = fork(workerPath(), [payloadPath], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const done = new Promise<RunResult>((resolve) => {
    let delivered = false;
    child.on("message", (message) => {
      if (delivered) return;
      delivered = true;
      const value = message as RunResult & { fatal?: string };
      resolve(value.fatal
        ? {
            run_id: path.basename(payloadPath, ".json"),
            status: "failed",
            error: value.fatal,
            model_calls: 0,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
          }
        : value);
    });
    child.on("exit", (code, signal) => {
      if (delivered) return;
      delivered = true;
      resolve({
        run_id: path.basename(payloadPath, ".json"),
        status: signal ? "interrupted" : "failed",
        error: `Worker exited without a result (code=${code ?? "null"}, signal=${signal ?? "none"})`,
        model_calls: 0,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      });
    });
  });
  return { child, done };
}

async function ensureWorkerRecord(plan: ExecutionPlan, output: string, result: RunResult): Promise<void> {
  const run = plan.runs.find((item) => item.run_id === result.run_id);
  if (!run) return;
  const runDirectory = path.join(output, "runs", run.run_id);
  const eventPath = path.join(runDirectory, "events.jsonl");
  const finalPath = path.join(runDirectory, "final-state.json");
  if (!(await pathExists(eventPath))) {
    const recorder = new RunRecorder(runDirectory, run);
    await recorder.initialize({
      authored_experiment: plan.authored.experiment,
      resolved_condition: plan.conditions.find((item) => item.id === run.condition_id),
      scenario: plan.scenarios.find((item) => item.id === run.scenario_id),
      run,
      runtime: plan.runtime,
    });
    await recorder.record(result.status === "interrupted" ? "cancellation" : "worker_failure", {
      reason: result.error ?? "worker_exited_before_recording",
    });
    await recorder.writeMessages([]);
    await recorder.writeWorkspaceManifest([], []);
    await recorder.finalize(result.status, {
      started_at: result.started_at,
      model_calls: result.model_calls,
      ...(result.error ? { error: result.error } : {}),
    });
  } else if (!(await pathExists(finalPath))) {
    await atomicWriteJson(finalPath, {
      schema_version: 1,
      run_id: run.run_id,
      status: result.status,
      started_at: result.started_at,
      finished_at: result.finished_at,
      model_calls: result.model_calls,
      ...(result.error ? { error: result.error } : {}),
    });
  }
}

export async function runPlan(
  plan: ExecutionPlan,
  options: { output?: string; concurrency?: number } = {},
): Promise<BatchResult> {
  const stale = await validateSavedPlan(plan);
  if (stale.some((item) => item.severity === "error")) throw new DiagnosticError("Saved plan is stale or invalid", stale);
  const output = path.resolve(options.output ?? path.join(plan.root, "results", plan.execution_id));
  const control = path.join(output, ".control");
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length > 0) throw new Error(`Output directory must be empty: ${output}`);
  // An exclusive mkdir also prevents two schedulers from claiming the same empty output.
  await mkdir(control);
  await mkdir(path.join(output, "runs"), { recursive: true });
  await atomicWriteJson(path.join(output, "plan.json"), plan);
  await copyAssets(plan, output);

  const statuses: Record<string, RunStatus> = Object.fromEntries(plan.runs.map((run) => [run.run_id, "pending"]));
  const results: RunResult[] = [];
  const startedAt = new Date().toISOString();
  const writeManifest = () => atomicWriteJson(path.join(output, "manifest.json"), {
    schema_version: 1,
    experiment_id: plan.experiment_id,
    execution_id: plan.execution_id,
    plan_hash: plan.plan_hash,
    started_at: startedAt,
    updated_at: new Date().toISOString(),
    statuses,
    complete: Object.values(statuses).every((status) => !["pending", "running"].includes(status)),
  });
  await writeManifest();

  let next = 0;
  let interrupted = false;
  let stopScheduling = false;
  const active = new Map<string, ChildProcess>();
  const interrupt = (): void => {
    interrupted = true;
    stopScheduling = true;
    process.exitCode = 1;
    for (const child of active.values()) child.kill("SIGTERM");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  const executeNext = async (): Promise<void> => {
    while (!stopScheduling) {
      const index = next++;
      const run = plan.runs[index];
      if (!run) return;
      const payloadPath = path.join(control, `${run.run_id}.json`);
      const payload: WorkerPayload = { plan, run, output };
      await atomicWriteJson(payloadPath, payload);
      if (stopScheduling) return;
      const spawned = spawnTrial(payloadPath);
      active.set(run.run_id, spawned.child);
      statuses[run.run_id] = "running";
      await writeManifest();
      const result = await spawned.done;
      active.delete(run.run_id);
      await ensureWorkerRecord(plan, output, result);
      statuses[run.run_id] = result.status;
      results.push(result);
      await writeManifest();
      if (result.status !== "completed" && plan.execution.failure_policy === "stop") stopScheduling = true;
    }
  };

  try {
    const concurrency = Math.max(1, options.concurrency ?? plan.execution.concurrency);
    await Promise.all(Array.from({ length: concurrency }, () => executeNext()));
    if (stopScheduling) {
      for (const run of plan.runs.filter((item) => statuses[item.run_id] === "pending")) {
        const status: RunStatus = "interrupted";
        statuses[run.run_id] = status;
        const started = new Date().toISOString();
        const recorder = new RunRecorder(path.join(output, "runs", run.run_id), run);
        await recorder.initialize({
          authored_experiment: plan.authored.experiment,
          resolved_condition: plan.conditions.find((item) => item.id === run.condition_id),
          scenario: plan.scenarios.find((item) => item.id === run.scenario_id),
          run,
          runtime: plan.runtime,
        });
        await recorder.record(interrupted ? "cancellation" : "not_scheduled", {
          reason: interrupted ? "batch_interrupted_before_worker_start" : "failure_policy_stop",
        });
        await recorder.writeMessages([]);
        await recorder.writeWorkspaceManifest([], []);
        await recorder.finalize(status, {
          started_at: started,
          model_calls: 0,
          termination: interrupted ? "interrupted_before_start" : "failure_policy_stop",
        });
        results.push({
          run_id: run.run_id,
          status,
          model_calls: 0,
          started_at: started,
          finished_at: new Date().toISOString(),
        });
      }
    }
    await writeManifest();
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await rm(control, { recursive: true, force: true });
  }
  return {
    output,
    results,
    exitCode: Object.values(statuses).every((status) => status === "completed") ? 0 : 1,
  };
}

export async function loadPlan(planPath: string): Promise<ExecutionPlan> {
  return readJson<ExecutionPlan>(path.resolve(planPath));
}
