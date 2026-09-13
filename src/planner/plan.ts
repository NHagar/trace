import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  BaselineConfig,
  Diagnostic,
  ExecutionPlan,
  ExperimentConfig,
  PlannedRun,
  ResolvedCondition,
} from "../types.js";
import { PI_VERSION } from "../types.js";
import {
  loadExperiment,
  loaderDiagnosticSink,
  resolveAxisValue,
  resolveConditionOverrides,
  validateResolvedBaselineFields,
  type LoadedExperiment,
} from "../config/load.js";
import { validateBaseline, validateExperimentShape, validateScenarios } from "../config/validate.js";
import { pathExists, sha256File } from "../util/fs.js";
import { deepMerge, hashJson, setPath, slug, stableStringify } from "../util/object.js";
import { shuffle } from "../util/random.js";

export interface CheckResult {
  diagnostics: Diagnostic[];
  plan?: ExecutionPlan;
}

const BASELINE_DEFAULTS: Partial<BaselineConfig> = {
  session: {
    compaction: { enabled: true, reserve_tokens: 16_384, keep_recent_tokens: 20_000 },
    retries: { enabled: true, max_retries: 3, base_delay_ms: 2_000, provider: { max_retry_delay_ms: 60_000 } },
  },
  limits: { wall_clock_ms: 300_000, max_model_calls: 100 },
};

const EXECUTION_DEFAULTS: Required<NonNullable<ExperimentConfig["execution"]>> = {
  concurrency: 1,
  order: "declared",
  seed: 0,
  failure_policy: "continue",
};

function cartesian<T>(axes: Array<[string, T[]]>): Array<Array<[string, T]>> {
  let rows: Array<Array<[string, T]>> = [[]];
  for (const [axis, values] of axes) {
    rows = rows.flatMap((row) => values.map((value) => [...row, [axis, value] as [string, T]]));
  }
  return rows;
}

async function expandConditions(loaded: LoadedExperiment): Promise<ResolvedCondition[]> {
  const { experiment, baseline, experimentPath } = loaded;
  const sink = loaderDiagnosticSink(loaded);
  const pending: Array<{ id: string; mapping: Record<string, string>; overrides: Record<string, unknown> }> = [];

  if (experiment.conditions) {
    for (const [index, condition] of experiment.conditions.entries()) {
      pending.push({
        id: slug(condition.id),
        mapping: {},
        overrides: await resolveConditionOverrides(
          condition.overrides,
          experimentPath,
          sink,
          `experiment.conditions[${index}].overrides`,
        ),
      });
    }
  } else if (experiment.matrix) {
    const axes = Object.entries(experiment.matrix.axes);
    for (const combination of cartesian(axes)) {
      const mapping: Record<string, string> = {};
      const overrides: Record<string, unknown> = {};
      const idParts: string[] = [];
      for (const [axis, axisValue] of combination) {
        mapping[axis] = axisValue.id;
        idParts.push(`${slug(axis)}-${slug(axisValue.id)}`);
        setPath(
          overrides,
          axis,
          await resolveAxisValue(
            axis,
            axisValue.value,
            experimentPath,
            sink,
            `experiment.matrix.axes.${axis}.${axisValue.id}`,
          ),
        );
      }
      pending.push({ id: idParts.join("__"), mapping, overrides });
    }
  } else {
    pending.push({ id: "baseline", mapping: {}, overrides: {} });
  }

  const conditions: ResolvedCondition[] = [];
  const seenIds = new Set<string>();
  const seenConfig = new Map<string, string>();
  for (const item of pending) {
    if (seenIds.has(item.id)) {
      loaded.diagnostics.push({
        severity: "error",
        code: "duplicate_condition_id",
        message: `Condition IDs collide after normalization: ${item.id}`,
        path: `condition:${item.id}`,
      });
      continue;
    }
    seenIds.add(item.id);
    let config: BaselineConfig;
    try {
      config = deepMerge(
        deepMerge(BASELINE_DEFAULTS, baseline),
        item.overrides,
      ) as BaselineConfig;
    } catch (error) {
      loaded.diagnostics.push({
        severity: "error",
        code: "invalid_override",
        message: `Condition ${item.id}: ${(error as Error).message}`,
        path: `condition:${item.id}`,
      });
      continue;
    }
    config = await validateResolvedBaselineFields(config, experimentPath, sink, `condition:${item.id}`);
    validateBaseline(config, loaded.diagnostics, `condition:${item.id}`);
    const canonical = stableStringify(config);
    const duplicateOf = seenConfig.get(canonical);
    if (duplicateOf && !experiment.allow_duplicate_conditions) {
      loaded.diagnostics.push({
        severity: "error",
        code: "duplicate_condition",
        message: `Conditions ${duplicateOf} and ${item.id} resolve to identical configurations`,
        path: `condition:${item.id}`,
      });
    } else seenConfig.set(canonical, item.id);
    conditions.push({ id: item.id, mapping: item.mapping, config, config_hash: hashJson(config) });
  }
  return conditions;
}

function makeRuns(
  executionId: string,
  conditions: ResolvedCondition[],
  loaded: LoadedExperiment,
  execution: Required<NonNullable<ExperimentConfig["execution"]>>,
): PlannedRun[] {
  const repetitions = loaded.experiment.repetitions ?? 1;
  const runs: PlannedRun[] = [];
  let ordinal = 0;
  for (const condition of conditions) {
    for (const scenario of loaded.scenarios) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        ordinal += 1;
        runs.push({
          run_id: `${slug(condition.id)}--${slug(scenario.id)}--r${String(repetition).padStart(3, "0")}`,
          condition_id: condition.id,
          scenario_id: scenario.id,
          repetition,
          seed: (execution.seed + ordinal * 2_654_435_761) >>> 0,
        });
      }
    }
  }
  void executionId;
  return execution.order === "randomized" ? shuffle(runs, execution.seed) : runs;
}

async function buildContentHashes(loaded: LoadedExperiment): Promise<ExecutionPlan["content_hashes"]> {
  const hashes = [];
  for (const filePath of [...loaded.referencedFiles].sort()) {
    if (!(await pathExists(filePath))) continue;
    const hash = await sha256File(filePath);
    hashes.push({
      ...hash,
      path: path.relative(loaded.root, filePath).startsWith("..") ? filePath : path.relative(loaded.root, filePath),
    });
  }
  return hashes;
}

export async function planExperiment(
  directory = ".",
  executionOverrides: Partial<Required<NonNullable<ExperimentConfig["execution"]>>> = {},
): Promise<CheckResult> {
  const loaded = await loadExperiment(directory);
  validateExperimentShape(loaded.experiment, loaded.diagnostics);
  validateScenarios(loaded.scenarios, loaded.diagnostics);
  const conditions = await expandConditions(loaded);
  const errors = loaded.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) return { diagnostics: loaded.diagnostics };

  const execution = { ...EXECUTION_DEFAULTS, ...(loaded.experiment.execution ?? {}), ...executionOverrides };
  const executionId = `${slug(loaded.experiment.id)}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomUUID().slice(0, 8)}`;
  const contentHashes = await buildContentHashes(loaded);
  const lock = contentHashes.find((entry) => path.basename(entry.path) === "package-lock.json");
  const warnings = [
    "Static checks do not verify credentials, provider availability, or custom implementation behavior.",
    "Model aliases may change remotely; requested and provider-reported identifiers are recorded at run time.",
  ];
  const unsigned = {
    schema_version: 1 as const,
    plan_version: 1 as const,
    experiment_id: loaded.experiment.id,
    execution_id: executionId,
    created_at: new Date().toISOString(),
    root: loaded.root,
    authored: { experiment: loaded.experiment, baseline: loaded.authoredBaseline },
    runtime: {
      node: process.version,
      runner: "0.1.0",
      pi: PI_VERSION,
      ...(lock ? { dependency_lock_sha256: lock.sha256 } : {}),
    },
    content_hashes: contentHashes,
    conditions,
    scenarios: loaded.scenarios,
    runs: makeRuns(executionId, conditions, loaded, execution),
    execution,
    warnings,
  };
  const plan: ExecutionPlan = { ...unsigned, plan_hash: hashJson(unsigned) };
  return { diagnostics: loaded.diagnostics, plan };
}

export async function validateSavedPlan(plan: ExecutionPlan): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  if (plan.runtime.runner !== "0.1.0" || plan.runtime.pi !== PI_VERSION || plan.runtime.node !== process.version) {
    diagnostics.push({
      severity: "error",
      code: "stale_runtime",
      message: `Saved plan runtime differs (plan: runner ${plan.runtime.runner}, Pi ${plan.runtime.pi}, ${plan.runtime.node}; current: runner 0.1.0, Pi ${PI_VERSION}, ${process.version})`,
    });
  }
  const unsigned = { ...plan } as Record<string, unknown>;
  delete unsigned.plan_hash;
  if (hashJson(unsigned) !== plan.plan_hash) {
    diagnostics.push({ severity: "error", code: "plan_tampered", message: "Saved plan content does not match plan_hash" });
  }
  for (const entry of plan.content_hashes) {
    const filePath = path.isAbsolute(entry.path) ? entry.path : path.join(plan.root, entry.path);
    if (!(await pathExists(filePath))) {
      diagnostics.push({ severity: "error", code: "stale_plan", message: `Referenced asset is missing: ${entry.path}`, path: entry.path });
      continue;
    }
    const current = await sha256File(filePath);
    if (current.sha256 !== entry.sha256 || current.size !== entry.size) {
      diagnostics.push({ severity: "error", code: "stale_plan", message: `Referenced asset changed: ${entry.path}`, path: entry.path });
    }
  }
  return diagnostics;
}
