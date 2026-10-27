import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type {
  BaselineConfig,
  Diagnostic,
  ExperimentConfig,
  JsonObject,
  MemoryConfig,
  ModelConfig,
  ScenarioConfig,
  SystemPromptConfig,
  ToolEntryConfig,
  ToolRegistryConfig,
} from "../types.js";
import { isPlainObject } from "../util/object.js";
import { pathExists, resolveFrom, walkFiles } from "../util/fs.js";

export interface LoadedExperiment {
  root: string;
  experimentPath: string;
  experiment: ExperimentConfig;
  authoredBaseline: unknown;
  baseline: BaselineConfig;
  scenarios: ScenarioConfig[];
  referencedFiles: Set<string>;
  referencedDirectories: Set<string>;
  dependencyLockPath?: string;
  diagnostics: Diagnostic[];
}

interface LoaderState {
  diagnostics: Diagnostic[];
  referencedFiles: Set<string>;
  referencedDirectories: Set<string>;
  referenceStack: string[];
}

const EXPERIMENT_KEYS = new Set([
  "schema_version",
  "id",
  "base",
  "conditions",
  "matrix",
  "scenarios",
  "repetitions",
  "allow_duplicate_conditions",
  "execution",
]);
const BASELINE_KEYS = new Set([
  "schema_version",
  "pi_version",
  "model",
  "tools",
  "system_prompt",
  "memory",
  "session",
  "resources",
  "limits",
]);

function diagnostic(state: LoaderState, code: string, message: string, path?: string): void {
  state.diagnostics.push({ severity: "error", code, message, ...(path ? { path } : {}) });
}

function warning(state: LoaderState, code: string, message: string, path?: string): void {
  state.diagnostics.push({ severity: "warning", code, message, ...(path ? { path } : {}) });
}

function knownKeys(
  state: LoaderState,
  value: unknown,
  keys: ReadonlySet<string>,
  location: string,
): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    diagnostic(state, "invalid_type", `${location} must be an object`, location);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) diagnostic(state, "unknown_field", `Unknown field ${location}.${key}`, `${location}.${key}`);
  }
  return true;
}

function rejectNulls(state: LoaderState, value: unknown, location: string): void {
  if (value === null) {
    diagnostic(state, "null_not_allowed", `null is not permitted at ${location}`, location);
    return;
  }
  if (Array.isArray(value)) value.forEach((item, index) => rejectNulls(state, item, `${location}[${index}]`));
  else if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) rejectNulls(state, child, `${location}.${key}`);
  }
}

async function readYaml(filePath: string, state: LoaderState): Promise<unknown> {
  state.referencedFiles.add(filePath);
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    diagnostic(state, "missing_resource", `Cannot read ${filePath}: ${(error as Error).message}`, filePath);
    return {};
  }
  const document = YAML.parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    for (const error of document.errors) diagnostic(state, "yaml_parse", error.message, filePath);
    return {};
  }
  const value = document.toJS() as unknown;
  rejectNulls(state, value, filePath);
  return value;
}

async function loadReference(filePath: string, state: LoaderState): Promise<unknown> {
  const absolute = path.resolve(filePath);
  if (state.referenceStack.includes(absolute)) {
    diagnostic(
      state,
      "reference_cycle",
      `Reference cycle: ${[...state.referenceStack, absolute].join(" -> ")}`,
      absolute,
    );
    return {};
  }
  state.referenceStack.push(absolute);
  const value = await readYaml(absolute, state);
  state.referenceStack.pop();
  return value;
}

function isReference(value: unknown): value is { from: string } {
  return isPlainObject(value) && Object.keys(value).length === 1 && typeof value.from === "string";
}

async function resolveComponentReference(
  value: unknown,
  declaringFile: string,
  state: LoaderState,
  location: string,
): Promise<{ value: unknown; declaringFile: string }> {
  let current = value;
  let currentFile = declaringFile;
  const visited: string[] = [];
  while (isReference(current)) {
    const target = resolveFrom(currentFile, current.from);
    if (!/\.ya?ml$/i.test(target)) {
      diagnostic(state, "invalid_reference", `${location} references must be YAML files`, location);
      return { value: {}, declaringFile };
    }
    if (visited.includes(target)) {
      diagnostic(state, "reference_cycle", `Reference cycle: ${[...visited, target].join(" -> ")}`, location);
      return { value: {}, declaringFile };
    }
    visited.push(target);
    current = await loadReference(target, state);
    currentFile = target;
  }
  return { value: current, declaringFile: currentFile };
}

async function registerPath(
  rawPath: unknown,
  declaringFile: string,
  state: LoaderState,
  location: string,
): Promise<string | undefined> {
  if (rawPath === undefined) return undefined;
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    diagnostic(state, "invalid_path", `${location} must be a non-empty path`, location);
    return undefined;
  }
  const absolute = resolveFrom(declaringFile, rawPath);
  if (!(await pathExists(absolute))) {
    diagnostic(state, "missing_resource", `Missing resource: ${absolute}`, location);
    return absolute;
  }
  if ((await stat(absolute)).isDirectory()) state.referencedDirectories.add(absolute);
  for (const file of await walkFiles(absolute)) state.referencedFiles.add(file);
  return absolute;
}

async function resolveModel(
  raw: unknown,
  declaringFile: string,
  state: LoaderState,
  location: string,
): Promise<ModelConfig | undefined> {
  if (raw === undefined) return undefined;
  const resolved = await resolveComponentReference(raw, declaringFile, state, location);
  if (
    !knownKeys(
      state,
      resolved.value,
      new Set(["provider", "id", "thinking", "settings", "fixture", "capabilities"]),
      location,
    )
  ) return undefined;
  const model = structuredClone(resolved.value) as unknown as ModelConfig;
  if (model.fixture) {
    if (knownKeys(state, model.fixture, new Set(["responses", "context_window", "tokens_per_second"]), `${location}.fixture`)) {
      const fixturePath = await registerPath(
        model.fixture.responses,
        resolved.declaringFile,
        state,
        `${location}.fixture.responses`,
      );
      if (fixturePath) model.fixture.responses = fixturePath;
    }
  }
  if (model.settings) knownKeys(state, model.settings, new Set(["temperature", "max_tokens", "top_p"]), `${location}.settings`);
  if (model.capabilities) knownKeys(state, model.capabilities, new Set(["reasoning", "settings"]), `${location}.capabilities`);
  return model;
}

async function resolvePrompt(
  raw: unknown,
  declaringFile: string,
  state: LoaderState,
  location: string,
): Promise<SystemPromptConfig> {
  const resolved = await resolveComponentReference(raw, declaringFile, state, location);
  knownKeys(state, resolved.value, new Set(["mode", "file", "text"]), location);
  const prompt = structuredClone(resolved.value) as unknown as SystemPromptConfig;
  const filePath = await registerPath(prompt.file, resolved.declaringFile, state, `${location}.file`);
  if (filePath) prompt.file = filePath;
  return prompt;
}

async function resolveTools(
  raw: unknown,
  declaringFile: string,
  state: LoaderState,
  location: string,
): Promise<ToolRegistryConfig> {
  const resolved = await resolveComponentReference(raw, declaringFile, state, location);
  knownKeys(state, resolved.value, new Set(["mode", "remove", "entries"]), location);
  const tools = structuredClone(resolved.value) as unknown as ToolRegistryConfig;
  if (Array.isArray(tools.entries)) {
    for (let index = 0; index < tools.entries.length; index += 1) {
      const entry = tools.entries[index]!;
      const entryLocation = `${location}.entries[${index}]`;
      knownKeys(
        state,
        entry,
        new Set(["name", "source", "builtin", "module", "export", "fixture", "description", "parameters", "replace", "config"]),
        entryLocation,
      );
      const modulePath = await registerPath(entry.module, resolved.declaringFile, state, `${entryLocation}.module`);
      const fixturePath = await registerPath(entry.fixture, resolved.declaringFile, state, `${entryLocation}.fixture`);
      if (modulePath) entry.module = modulePath;
      if (fixturePath) entry.fixture = fixturePath;
    }
  }
  return tools;
}

async function resolveMemory(
  raw: unknown,
  declaringFile: string,
  state: LoaderState,
  location: string,
): Promise<MemoryConfig | undefined> {
  if (raw === undefined) return undefined;
  const resolved = await resolveComponentReference(raw, declaringFile, state, location);
  if (!knownKeys(state, resolved.value, new Set(["contents", "retrieval", "representation", "delivery", "mutability"]), location)) {
    return undefined;
  }
  const memory = structuredClone(resolved.value) as unknown as MemoryConfig;
  const contents = await registerPath(memory.contents, resolved.declaringFile, state, `${location}.contents`);
  if (contents) memory.contents = contents;
  const strategies: Array<["retrieval" | "representation", Record<string, unknown> | undefined]> = [
    ["retrieval", isPlainObject(memory.retrieval) ? memory.retrieval : undefined],
    ["representation", isPlainObject(memory.representation) ? memory.representation : undefined],
  ];
  for (const [key, strategy] of strategies) {
    if (!strategy) continue;
    const allowed = strategy.type === "custom" ? new Set(["type", "module", "export", "factory", "config"]) : new Set(["type"]);
    knownKeys(state, strategy, allowed, `${location}.${key}`);
    if (strategy.type === "custom" && typeof strategy.module === "string") {
      const modulePath = await registerPath(strategy.module, resolved.declaringFile, state, `${location}.${key}.module`);
      if (modulePath) strategy.module = modulePath;
    }
  }
  if (memory.delivery && isPlainObject(memory.delivery)) {
    const common = ["type"];
    const byType: Record<string, string[]> = {
      "system-prompt": ["timing"],
      "context-message": ["role", "placement", "timing"],
      tool: ["name"],
      files: ["destination"],
    };
    knownKeys(state, memory.delivery, new Set([...common, ...(byType[memory.delivery.type as string] ?? [])]), `${location}.delivery`);
  }
  return memory;
}

async function resolveBaseline(
  raw: unknown,
  baselinePath: string,
  state: LoaderState,
): Promise<BaselineConfig> {
  knownKeys(state, raw, BASELINE_KEYS, "baseline");
  const object = isPlainObject(raw) ? structuredClone(raw) : {};
  const baseline = object as unknown as BaselineConfig;
  const model = await resolveModel(object.model, baselinePath, state, "baseline.model");
  if (model) baseline.model = model;
  else delete baseline.model;
  baseline.tools = await resolveTools(object.tools, baselinePath, state, "baseline.tools");
  baseline.system_prompt = await resolvePrompt(object.system_prompt, baselinePath, state, "baseline.system_prompt");
  const memory = await resolveMemory(object.memory, baselinePath, state, "baseline.memory");
  if (memory) baseline.memory = memory;
  else delete baseline.memory;
  if (isPlainObject(object.session)) {
    knownKeys(state, object.session, new Set(["compaction", "retries"]), "baseline.session");
    if (isPlainObject(object.session.compaction)) knownKeys(state, object.session.compaction, new Set(["enabled", "reserve_tokens", "keep_recent_tokens"]), "baseline.session.compaction");
    if (isPlainObject(object.session.retries)) {
      knownKeys(state, object.session.retries, new Set(["enabled", "max_retries", "base_delay_ms", "provider"]), "baseline.session.retries");
      if (isPlainObject(object.session.retries.provider)) knownKeys(state, object.session.retries.provider, new Set(["timeout_ms", "max_retries", "max_retry_delay_ms"]), "baseline.session.retries.provider");
    }
  }
  if (isPlainObject(object.resources)) knownKeys(state, object.resources, new Set(["ambient_discovery"]), "baseline.resources");
  if (isPlainObject(object.limits)) knownKeys(state, object.limits, new Set(["wall_clock_ms", "max_model_calls"]), "baseline.limits");
  return baseline;
}

async function resolveScenario(raw: unknown, scenarioPath: string, state: LoaderState): Promise<ScenarioConfig> {
  knownKeys(state, raw, new Set(["schema_version", "id", "workspace", "conversation", "memory_between_steps", "steps"]), `scenario:${scenarioPath}`);
  const scenario = structuredClone(raw) as unknown as ScenarioConfig;
  scenario.source_path = scenarioPath;
  if (scenario.workspace && isPlainObject(scenario.workspace)) {
    knownKeys(state, scenario.workspace, new Set(["fixtures"]), `scenario:${scenarioPath}.workspace`);
    const fixturePath = await registerPath(scenario.workspace.fixtures, scenarioPath, state, `scenario:${scenarioPath}.workspace.fixtures`);
    if (fixturePath) scenario.workspace.fixtures = fixturePath;
  }
  if (Array.isArray(scenario.steps)) {
    for (let index = 0; index < scenario.steps.length; index += 1) {
      knownKeys(state, scenario.steps[index], new Set(["id", "input"]), `scenario:${scenarioPath}.steps[${index}]`);
    }
  }
  return scenario;
}

export async function resolveOverrideReferences(
  raw: unknown,
  declaringFile: string,
  state: Pick<LoaderState, "diagnostics" | "referencedFiles" | "referencedDirectories">,
  location: string,
): Promise<unknown> {
  const loaderState: LoaderState = { ...state, referenceStack: [] };
  if (isReference(raw)) {
    const target = resolveFrom(declaringFile, raw.from);
    return loadReference(target, loaderState);
  }
  if (Array.isArray(raw)) {
    return Promise.all(raw.map((value, index) => resolveOverrideReferences(value, declaringFile, loaderState, `${location}[${index}]`)));
  }
  if (isPlainObject(raw)) {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      output[key] = await resolveOverrideReferences(value, declaringFile, loaderState, `${location}.${key}`);
    }
    return output;
  }
  return raw;
}

export async function loadExperiment(directory = "."): Promise<LoadedExperiment> {
  const root = path.resolve(directory);
  const experimentPath = path.join(root, "experiment.yaml");
  const state: LoaderState = { diagnostics: [], referencedFiles: new Set(), referencedDirectories: new Set(), referenceStack: [] };
  const experimentRaw = await readYaml(experimentPath, state);
  knownKeys(state, experimentRaw, EXPERIMENT_KEYS, "experiment");
  const experiment = structuredClone(experimentRaw) as unknown as ExperimentConfig;

  if (isPlainObject(experimentRaw) && isPlainObject(experimentRaw.execution)) {
    knownKeys(state, experimentRaw.execution, new Set(["concurrency", "order", "seed", "failure_policy"]), "experiment.execution");
  }
  if (isPlainObject(experimentRaw) && Array.isArray(experimentRaw.conditions)) {
    for (let index = 0; index < experimentRaw.conditions.length; index += 1) {
      knownKeys(state, experimentRaw.conditions[index], new Set(["id", "overrides"]), `experiment.conditions[${index}]`);
    }
  }
  if (isPlainObject(experimentRaw) && isPlainObject(experimentRaw.matrix)) {
    knownKeys(state, experimentRaw.matrix, new Set(["axes"]), "experiment.matrix");
    if (isPlainObject(experimentRaw.matrix.axes)) {
      for (const [axis, values] of Object.entries(experimentRaw.matrix.axes)) {
        if (!Array.isArray(values)) diagnostic(state, "invalid_matrix", `Matrix axis ${axis} must be an array`, `experiment.matrix.axes.${axis}`);
        else values.forEach((value, index) => knownKeys(state, value, new Set(["id", "value"]), `experiment.matrix.axes.${axis}[${index}]`));
      }
    }
  }

  const baseValue = isPlainObject(experimentRaw) ? experimentRaw.base : undefined;
  const baselinePath = typeof baseValue === "string" ? resolveFrom(experimentPath, baseValue) : path.join(root, "baseline.yaml");
  if (typeof baseValue !== "string") diagnostic(state, "required_field", "experiment.base must be a path", "experiment.base");
  const authoredBaseline = await loadReference(baselinePath, state);
  const baseline = await resolveBaseline(authoredBaseline, baselinePath, state);

  const scenarios: ScenarioConfig[] = [];
  if (!Array.isArray(experiment.scenarios) || experiment.scenarios.length === 0) {
    diagnostic(state, "required_field", "experiment.scenarios must contain at least one scenario", "experiment.scenarios");
  } else {
    for (const rawPath of experiment.scenarios) {
      if (typeof rawPath !== "string") {
        diagnostic(state, "invalid_path", "Scenario references must be paths", "experiment.scenarios");
        continue;
      }
      const scenarioPath = resolveFrom(experimentPath, rawPath);
      scenarios.push(await resolveScenario(await loadReference(scenarioPath, state), scenarioPath, state));
    }
  }

  let dependencyLockPath: string | undefined;
  for (const filename of ["npm-shrinkwrap.json", "package-lock.json"]) {
    const candidate = fileURLToPath(new URL(`../../${filename}`, import.meta.url));
    if (await pathExists(candidate)) {
      dependencyLockPath = candidate;
      state.referencedFiles.add(candidate);
      break;
    }
  }
  if (!dependencyLockPath) warning(state, "missing_lockfile", "Runner dependency lock is unavailable; dependency lock hash will be unavailable");
  const experimentLock = path.join(root, "experiment.lock.json");
  if (await pathExists(experimentLock)) state.referencedFiles.add(experimentLock);

  return {
    root,
    experimentPath,
    experiment,
    authoredBaseline,
    baseline,
    scenarios,
    referencedFiles: state.referencedFiles,
    referencedDirectories: state.referencedDirectories,
    ...(dependencyLockPath ? { dependencyLockPath } : {}),
    diagnostics: state.diagnostics,
  };
}

export function loaderDiagnosticSink(loaded: LoadedExperiment): Pick<LoaderState, "diagnostics" | "referencedFiles" | "referencedDirectories"> {
  return { diagnostics: loaded.diagnostics, referencedFiles: loaded.referencedFiles, referencedDirectories: loaded.referencedDirectories };
}

function makeLoaderState(
  sink: Pick<LoaderState, "diagnostics" | "referencedFiles" | "referencedDirectories">,
): LoaderState {
  return { diagnostics: sink.diagnostics, referencedFiles: sink.referencedFiles, referencedDirectories: sink.referencedDirectories, referenceStack: [] };
}

export async function resolveConditionOverrides(
  raw: unknown,
  declaringFile: string,
  sink: Pick<LoaderState, "diagnostics" | "referencedFiles" | "referencedDirectories">,
  location: string,
): Promise<Record<string, unknown>> {
  const state = makeLoaderState(sink);
  if (!isPlainObject(raw)) {
    diagnostic(state, "invalid_override", `${location} must be an object`, location);
    return {};
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!BASELINE_KEYS.has(key) || ["schema_version", "pi_version", "resources"].includes(key)) {
      diagnostic(state, "invalid_override", `Cannot override ${key}`, `${location}.${key}`);
      continue;
    }
    if (key === "model") output[key] = await resolveModel(value, declaringFile, state, `${location}.model`);
    else if (key === "tools") output[key] = await resolveTools(value, declaringFile, state, `${location}.tools`);
    else if (key === "memory") output[key] = await resolveMemory(value, declaringFile, state, `${location}.memory`);
    else if (key === "system_prompt") output[key] = await resolvePrompt(value, declaringFile, state, `${location}.system_prompt`);
    else output[key] = structuredClone(value);
  }
  return output;
}

export async function resolveAxisValue(
  axis: string,
  raw: unknown,
  declaringFile: string,
  sink: Pick<LoaderState, "diagnostics" | "referencedFiles" | "referencedDirectories">,
  location: string,
): Promise<unknown> {
  const state = makeLoaderState(sink);
  if (axis === "model") return resolveModel(raw, declaringFile, state, location);
  if (axis === "tools") return resolveTools(raw, declaringFile, state, location);
  if (axis === "memory") return resolveMemory(raw, declaringFile, state, location);
  if (axis === "system_prompt") return resolvePrompt(raw, declaringFile, state, location);
  if (isReference(raw)) {
    diagnostic(state, "invalid_reference", `{from: ...} is not allowed at scalar axis ${axis}`, location);
    return raw;
  }
  if (axis === "memory.contents" && typeof raw === "string") {
    return (await registerPath(raw, declaringFile, state, location)) ?? raw;
  }
  if (axis === "system_prompt.file" && typeof raw === "string") {
    return (await registerPath(raw, declaringFile, state, location)) ?? raw;
  }
  if (axis === "tools.entries") {
    return (await resolveTools({ mode: "replace", entries: raw }, declaringFile, state, location)).entries ?? raw;
  }
  if (axis === "memory.retrieval" || axis === "memory.representation") {
    const key = axis.split(".")[1]! as "retrieval" | "representation";
    const normalized = await resolveMemory({ [key]: raw }, declaringFile, state, location);
    return normalized?.[key] ?? raw;
  }
  return structuredClone(raw);
}

export async function validateResolvedBaselineFields(
  raw: unknown,
  declaringFile: string,
  sink: Pick<LoaderState, "diagnostics" | "referencedFiles" | "referencedDirectories">,
  location: string,
): Promise<BaselineConfig> {
  const state = makeLoaderState(sink);
  knownKeys(state, raw, BASELINE_KEYS, location);
  return raw as BaselineConfig;
}
