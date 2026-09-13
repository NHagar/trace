#!/usr/bin/env node
import path from "node:path";
import { atomicWriteJson } from "../util/fs.js";
import { hashJson } from "../util/object.js";
import { DiagnosticError } from "../errors.js";
import { planExperiment } from "../planner/plan.js";
import { loadPlan, runPlan } from "../execution/scheduler.js";
import { initializeExperiment } from "./init.js";
import type { Diagnostic, ExecutionPlan } from "../types.js";

interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const valueFlags = new Set(["--write-plan", "--plan", "--output", "--concurrency", "--seed"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) positionals.push(arg);
    else if (valueFlags.has(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      flags.set(arg, value);
    } else if (arg === "--json" || arg === "--help" || arg === "--version") flags.set(arg, true);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return { positionals, flags };
}

function numberFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
  for (const item of diagnostics) {
    const location = item.path ? ` (${item.path})` : "";
    const stream = item.severity === "error" ? process.stderr : process.stdout;
    stream.write(`${item.severity.toUpperCase()} ${item.code}${location}: ${item.message}\n`);
  }
}

function refreshPlanHash(plan: ExecutionPlan): void {
  const unsigned = { ...plan } as Record<string, unknown>;
  delete unsigned.plan_hash;
  plan.plan_hash = hashJson(unsigned);
}

function usage(): string {
  return `agent-study 0.1.0

Usage:
  agent-study init <directory>
  agent-study check [directory] [--json] [--write-plan <path>]
  agent-study run [directory] [--plan <path>] [--output <directory>] [--concurrency <n>] [--seed <integer>]
`;
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const command = args[0];
  const parsed = parseArgs(args.slice(1));
  if (!command || parsed.flags.has("--help")) {
    process.stdout.write(usage());
    return 0;
  }
  if (command === "--version") {
    process.stdout.write("0.1.0\n");
    return 0;
  }
  if (command === "init") {
    const directory = parsed.positionals[0];
    if (!directory) throw new Error("init requires a directory");
    const created = await initializeExperiment(directory);
    process.stdout.write(`Initialized ${path.resolve(directory)} (${created.length} files). Select an explicit provider/model, then run agent-study check.\n`);
    return 0;
  }
  if (command === "check") {
    const directory = parsed.positionals[0] ?? ".";
    const result = await planExperiment(directory);
    const valid = Boolean(result.plan) && !result.diagnostics.some((item) => item.severity === "error");
    if (parsed.flags.has("--json")) {
      process.stdout.write(`${JSON.stringify({ valid, diagnostics: result.diagnostics, plan: result.plan }, null, 2)}\n`);
    } else {
      printDiagnostics(result.diagnostics);
      if (result.plan) process.stdout.write(`Plan valid: ${result.plan.conditions.length} conditions × ${result.plan.scenarios.length} scenarios, ${result.plan.runs.length} runs.\n`);
    }
    const writePlan = parsed.flags.get("--write-plan");
    if (typeof writePlan === "string" && result.plan) await atomicWriteJson(path.resolve(writePlan), result.plan);
    return valid ? 0 : 1;
  }
  if (command === "run") {
    const planPath = parsed.flags.get("--plan");
    const seed = numberFlag(parsed.flags, "--seed");
    const concurrency = numberFlag(parsed.flags, "--concurrency");
    if (concurrency !== undefined && concurrency < 1) throw new Error("--concurrency must be positive");
    let plan: ExecutionPlan;
    if (typeof planPath === "string") {
      if (seed !== undefined) throw new Error("--seed cannot be combined with --plan; the saved trial order is frozen");
      plan = await loadPlan(planPath);
      if (concurrency !== undefined) {
        plan = structuredClone(plan);
        plan.execution.concurrency = concurrency;
        refreshPlanHash(plan);
      }
    } else {
      const directory = parsed.positionals[0] ?? ".";
      const result = await planExperiment(directory, {
        ...(seed !== undefined ? { seed } : {}),
        ...(concurrency !== undefined ? { concurrency } : {}),
      });
      printDiagnostics(result.diagnostics);
      if (!result.plan) throw new DiagnosticError("Experiment validation failed", result.diagnostics);
      plan = result.plan;
    }
    const outputFlag = parsed.flags.get("--output");
    const batch = await runPlan(plan, {
      ...(typeof outputFlag === "string" ? { output: outputFlag } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
    });
    process.stdout.write(`Execution ${plan.execution_id}: ${batch.results.filter((item) => item.status === "completed").length}/${plan.runs.length} runs completed. Results: ${batch.output}\n`);
    return batch.exitCode;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

void main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    if (error instanceof DiagnosticError) printDiagnostics(error.diagnostics);
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
