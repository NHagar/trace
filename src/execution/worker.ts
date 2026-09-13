#!/usr/bin/env node
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecutionPlan, PlannedRun, RunResult, RunStatus } from "../types.js";
import { LimitReachedError, InterruptedError } from "../errors.js";
import { readJson } from "../util/fs.js";
import { seededRandom } from "../util/random.js";
import { PiAdapter } from "../adapter/pi/adapter.js";
import { inventory, RunRecorder } from "../recording/recorder.js";

export interface WorkerPayload {
  plan: ExecutionPlan;
  run: PlannedRun;
  output: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function runWithLimit<T>(
  task: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Promise<void>,
): Promise<T> {
  if (timeoutMs <= 0) {
    await onTimeout();
    throw new LimitReachedError("wall_clock", "Wall-clock run limit reached");
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void onTimeout().finally(() => reject(new LimitReachedError("wall_clock", `Wall-clock limit (${timeoutMs}ms) reached`)));
    }, timeoutMs);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function executeTrial(payload: WorkerPayload): Promise<RunResult> {
  const { plan, run } = payload;
  const condition = plan.conditions.find((item) => item.id === run.condition_id);
  const scenario = plan.scenarios.find((item) => item.id === run.scenario_id);
  if (!condition || !scenario) throw new Error(`Invalid run references for ${run.run_id}`);
  const runDirectory = path.join(payload.output, "runs", run.run_id);
  const workspace = await mkdtemp(path.join(os.tmpdir(), `agent-study-${run.run_id}-`));
  const recorder = new RunRecorder(runDirectory, run);
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const controller = new AbortController();
  let adapter: PiAdapter | undefined;
  let activeSession: Awaited<ReturnType<PiAdapter["createSession"]>> | undefined;
  let status: RunStatus = "running";
  let failure: unknown;
  let initialFiles: Awaited<ReturnType<typeof inventory>> = [];
  let finalFiles: Awaited<ReturnType<typeof inventory>> = [];
  let currentStepId: string | undefined;
  const messages: unknown[] = [];

  const interrupt = (): void => {
    controller.abort();
    void activeSession?.session.abort();
  };
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);

  try {
    await recorder.initialize({
      authored_experiment: plan.authored.experiment,
      resolved_condition: condition,
      scenario,
      run,
      runtime: plan.runtime,
    });
    await recorder.record("run_status", { status: "running" });
    if (scenario.workspace?.fixtures) await cp(scenario.workspace.fixtures, workspace, { recursive: true });
    const ctx = {
      identity: { ...run, execution_id: plan.execution_id },
      experiment_root: plan.root,
      workspace,
      random: seededRandom(run.seed),
      signal: controller.signal,
      record: (type: string, data: Record<string, unknown> = {}) => recorder.record(type, data, currentStepId),
      recorded_client: {
        complete: async () => { throw new Error("Recorded model client is not initialized"); },
      },
    };
    adapter = new PiAdapter(condition.config, ctx);
    await adapter.initialize();
    initialFiles = await inventory(workspace);

    for (const [stepIndex, step] of scenario.steps.entries()) {
      if (controller.signal.aborted) throw new InterruptedError();
      currentStepId = step.id;
      if (stepIndex > 0 && scenario.memory_between_steps === "reset" && adapter.memoryStore) {
        await adapter.memoryStore.reset();
        await adapter.memoryStore.materializeFiles();
      }
      if (!activeSession || scenario.conversation === "fresh-per-step") {
        activeSession?.dispose();
        activeSession = await adapter.createSession();
      }
      adapter.setStep(step.id);
      await recorder.record("scenario_input", { input: step.input }, step.id);
      const wallClockLimit = condition.config.limits?.wall_clock_ms ?? 300_000;
      await runWithLimit(
        activeSession.session.prompt(step.input, { expandPromptTemplates: false, source: "rpc" }),
        wallClockLimit - (Date.now() - startedAtMs),
        () => activeSession!.session.abort(),
      );
      const maxCalls = condition.config.limits?.max_model_calls ?? 100;
      if (adapter.modelCalls > maxCalls) {
        throw new LimitReachedError("model_calls", `Maximum model calls (${maxCalls}) reached`);
      }
      const stepMessages = structuredClone(activeSession.session.messages);
      messages.push({ step_id: step.id, messages: stepMessages });
      const lastAssistant = [...activeSession.session.messages].reverse().find((message) => message.role === "assistant") as { stopReason?: string; errorMessage?: string } | undefined;
      if (lastAssistant?.stopReason === "error") throw new Error(lastAssistant.errorMessage ?? "Model response failed");
    }
    status = "completed";
  } catch (error) {
    failure = error;
    status = error instanceof LimitReachedError
      ? "limit_reached"
      : controller.signal.aborted || error instanceof InterruptedError
        ? "interrupted"
        : "failed";
    if (status === "limit_reached") await recorder.record("limit_reached", { limit: (error as LimitReachedError).limit });
    if (status === "interrupted") await recorder.record("cancellation", { reason: "signal" });
    await recorder.record("run_error", { status, error: errorText(error) });
  } finally {
    activeSession?.dispose();
    if (adapter?.memoryStore) await adapter.memoryStore.captureFileMutations();
    finalFiles = await inventory(workspace);
    await recorder.writeMessages(messages);
    await recorder.writeWorkspaceManifest(initialFiles, finalFiles);
    await recorder.preserveArtifacts(workspace, initialFiles, finalFiles);
    if (adapter?.memoryStore) {
      await mkdir(path.join(runDirectory, "artifacts"), { recursive: true });
      await adapter.memoryStore.persistWritableState(path.join(runDirectory, "artifacts", "memory-final.json"));
    }
    await recorder.finalize(status, {
      started_at: startedAt,
      model_calls: adapter?.modelCalls ?? 0,
      ...(adapter?.memoryStore ? { memory: adapter.memoryStore.snapshot() } : {}),
      ...(failure ? { error: errorText(failure) } : {}),
      ...(failure instanceof LimitReachedError ? { termination: failure.limit } : {}),
    });
    await rm(workspace, { recursive: true, force: true });
    process.removeListener("SIGTERM", interrupt);
    process.removeListener("SIGINT", interrupt);
  }
  return {
    run_id: run.run_id,
    status,
    ...(failure ? { error: errorText(failure) } : {}),
    model_calls: adapter?.modelCalls ?? 0,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const payloadPath = process.argv[2];
  if (!payloadPath) throw new Error("Worker payload path is required");
  const result = await executeTrial(await readJson<WorkerPayload>(payloadPath));
  if (process.send) process.send(result);
  else process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "completed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    if (process.send) process.send({ fatal: errorText(error) });
    process.stderr.write(`${errorText(error)}\n`);
    process.exitCode = 1;
  });
}
