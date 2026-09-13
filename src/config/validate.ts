import type {
  BaselineConfig,
  Diagnostic,
  ExperimentConfig,
  ScenarioConfig,
  ToolEntryConfig,
} from "../types.js";
import { isPlainObject } from "../util/object.js";
import { getModel } from "@earendil-works/pi-ai/compat";

const BUILTIN_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const MATRIX_PATHS = new Set([
  "model",
  "model.provider",
  "model.id",
  "model.thinking",
  "model.settings",
  "model.settings.temperature",
  "model.settings.max_tokens",
  "model.settings.top_p",
  "tools",
  "tools.mode",
  "tools.remove",
  "tools.entries",
  "system_prompt",
  "system_prompt.mode",
  "system_prompt.file",
  "system_prompt.text",
  "memory",
  "memory.contents",
  "memory.retrieval",
  "memory.representation",
  "memory.delivery",
  "memory.mutability",
  "session.compaction.enabled",
  "session.compaction.reserve_tokens",
  "session.compaction.keep_recent_tokens",
  "session.retries.enabled",
  "session.retries.max_retries",
  "session.retries.base_delay_ms",
  "session.retries.provider",
  "limits.wall_clock_ms",
  "limits.max_model_calls",
]);

function add(
  diagnostics: Diagnostic[],
  code: string,
  message: string,
  path?: string,
  severity: Diagnostic["severity"] = "error",
): void {
  diagnostics.push({ severity, code, message, ...(path ? { path } : {}) });
}

function uniqueIds(
  diagnostics: Diagnostic[],
  values: Array<{ id?: unknown }>,
  location: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (typeof value.id !== "string" || value.id.length === 0) {
      add(diagnostics, "invalid_id", `${location}[${index}].id must be a non-empty string`, `${location}[${index}].id`);
    } else if (seen.has(value.id)) {
      add(diagnostics, "duplicate_id", `Duplicate identifier ${value.id} in ${location}`, `${location}[${index}].id`);
    } else seen.add(value.id);
  }
}

export function resolveToolNames(tools: BaselineConfig["tools"]): string[] {
  const entries = tools.entries ?? [];
  if (tools.mode === "replace") return entries.map((entry) => entry.name);
  if (tools.mode === "pi-default") return [...DEFAULT_TOOLS];
  const names = DEFAULT_TOOLS.filter((name) => !(tools.remove ?? []).includes(name));
  for (const entry of entries) {
    const existing = names.indexOf(entry.name);
    if (existing >= 0) {
      if (entry.replace) names[existing] = entry.name;
    } else names.push(entry.name);
  }
  return names;
}

function validateTools(config: BaselineConfig, diagnostics: Diagnostic[], location: string): void {
  const tools = config.tools;
  if (!tools || !["pi-default", "replace", "extend"].includes(tools.mode)) {
    add(diagnostics, "invalid_tools", `${location}.tools.mode must be pi-default, replace, or extend`, `${location}.tools.mode`);
    return;
  }
  if (tools.mode === "pi-default" && ((tools.entries?.length ?? 0) > 0 || (tools.remove?.length ?? 0) > 0)) {
    add(diagnostics, "ambiguous_tools", "pi-default mode cannot declare entries or removals", `${location}.tools`);
  }
  if (tools.mode === "replace" && (tools.remove?.length ?? 0) > 0) {
    add(diagnostics, "ambiguous_tools", "replace mode cannot declare removals", `${location}.tools.remove`);
  }
  const entries = tools.entries ?? [];
  uniqueIds(diagnostics, entries.map(({ name }) => ({ id: name })), `${location}.tools.entries`);
  const active = new Set(tools.mode === "replace" ? [] : DEFAULT_TOOLS);
  for (const removed of tools.remove ?? []) {
    if (!active.has(removed)) add(diagnostics, "unknown_tool_removal", `Cannot remove missing tool ${removed}`, `${location}.tools.remove`);
    active.delete(removed);
  }
  for (const [index, entry] of entries.entries()) {
    const entryPath = `${location}.tools.entries[${index}]`;
    if (!entry.source || !["pi-builtin", "custom", "fixture", "memory"].includes(entry.source)) {
      add(diagnostics, "invalid_tool", `${entryPath}.source is invalid`, `${entryPath}.source`);
      continue;
    }
    if (entry.source === "pi-builtin" && !BUILTIN_TOOLS.has(entry.builtin ?? entry.name)) {
      add(diagnostics, "unknown_builtin_tool", `Unknown Pi built-in: ${entry.builtin ?? entry.name}`, entryPath);
    }
    if (entry.source === "custom" && !entry.module) add(diagnostics, "required_field", "Custom tools require module", `${entryPath}.module`);
    if (entry.source === "fixture" && !entry.fixture) add(diagnostics, "required_field", "Fixture tools require fixture", `${entryPath}.fixture`);
    if (entry.source === "memory" && config.memory?.delivery?.type !== "tool") {
      add(diagnostics, "unused_memory_tool", "A memory tool requires memory.delivery.type: tool", entryPath);
    }
    const replacesDefault = registryModeIsExtend(tools.mode) && DEFAULT_TOOLS.includes(entry.name);
    if (tools.mode === "extend" && DEFAULT_TOOLS.includes(entry.name) && !entry.replace) {
      add(diagnostics, "tool_conflict", `Tool ${entry.name} replaces a Pi default; set replace: true`, entryPath);
    } else if (active.has(entry.name) && !entry.replace) {
      add(diagnostics, "tool_conflict", `Tool ${entry.name} already exists; set replace: true`, entryPath);
    }
    if (!active.has(entry.name) && entry.replace && !replacesDefault && tools.mode !== "replace") {
      add(diagnostics, "invalid_replacement", `Tool ${entry.name} cannot replace a missing tool`, entryPath);
    }
    active.add(entry.name);
  }
  if (config.memory?.delivery?.type === "tool" && !active.has(config.memory.delivery.name)) {
    add(
      diagnostics,
      "missing_memory_tool",
      `Memory delivery tool ${config.memory.delivery.name} is not in the final registry`,
      `${location}.memory.delivery.name`,
    );
  }
}

function registryModeIsExtend(mode: BaselineConfig["tools"]["mode"]): boolean {
  return mode === "extend";
}

function validateModel(config: BaselineConfig, diagnostics: Diagnostic[], location: string): void {
  const model = config.model;
  if (!model || !model.provider?.trim() || !model.id?.trim() || /choose/i.test(model.provider) || /choose/i.test(model.id)) {
    add(diagnostics, "model_required", "Select an explicit provider and model ID", `${location}.model`);
    return;
  }
  const pinnedModel = model.provider === "fixture" || model.fixture ? undefined : getModel(model.provider as never, model.id);
  if (model.provider !== "fixture" && !model.fixture && !pinnedModel) {
    add(diagnostics, "unknown_model", `Model ${model.provider}/${model.id} is not in the pinned Pi catalog`, `${location}.model`);
  }
  const validThinking = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  if (model.thinking !== undefined && !validThinking.has(model.thinking)) {
    add(diagnostics, "unsupported_thinking", `Unsupported thinking level: ${model.thinking}`, `${location}.model.thinking`);
  }
  if (model.thinking && model.thinking !== "off" && (model.capabilities?.reasoning === false || pinnedModel?.reasoning === false)) {
    add(diagnostics, "model_incompatible", `Model ${model.provider}/${model.id} does not support thinking`, `${location}.model.thinking`);
  }
  if (model.settings) {
    const allowed = new Set(model.capabilities?.settings ?? ["temperature", "max_tokens", "top_p"]);
    for (const key of Object.keys(model.settings)) {
      if (!allowed.has(key as never)) {
        add(diagnostics, "model_incompatible", `${model.provider}/${model.id} does not support ${key}`, `${location}.model.settings.${key}`);
      }
    }
    if (model.settings.temperature !== undefined && (model.settings.temperature < 0 || model.settings.temperature > 2)) {
      add(diagnostics, "invalid_setting", "temperature must be between 0 and 2", `${location}.model.settings.temperature`);
    }
    if (model.settings.top_p !== undefined && (model.settings.top_p < 0 || model.settings.top_p > 1)) {
      add(diagnostics, "invalid_setting", "top_p must be between 0 and 1", `${location}.model.settings.top_p`);
    }
    if (model.settings.max_tokens !== undefined && (!Number.isInteger(model.settings.max_tokens) || model.settings.max_tokens < 1)) {
      add(diagnostics, "invalid_setting", "max_tokens must be a positive integer", `${location}.model.settings.max_tokens`);
    }
  }
}

function validatePrompt(config: BaselineConfig, diagnostics: Diagnostic[], location: string): void {
  const prompt = config.system_prompt;
  if (!prompt || !["pi-default", "append", "replace"].includes(prompt.mode)) {
    add(diagnostics, "invalid_prompt", "system_prompt.mode must be pi-default, append, or replace", `${location}.system_prompt.mode`);
    return;
  }
  const sources = Number(Boolean(prompt.file)) + Number(Boolean(prompt.text));
  if (prompt.mode === "pi-default" && sources > 0) add(diagnostics, "ambiguous_prompt", "pi-default cannot include file or text", `${location}.system_prompt`);
  if (prompt.mode !== "pi-default" && sources !== 1) add(diagnostics, "invalid_prompt", `${prompt.mode} requires exactly one of file or text`, `${location}.system_prompt`);
}

function validateMemory(config: BaselineConfig, diagnostics: Diagnostic[], location: string): void {
  const memory = config.memory;
  if (!memory) return;
  if (!memory.contents) add(diagnostics, "required_field", "Memory requires contents", `${location}.memory.contents`);
  if (!memory.retrieval) add(diagnostics, "required_field", "Memory requires retrieval", `${location}.memory.retrieval`);
  if (!memory.representation) add(diagnostics, "required_field", "Memory requires representation", `${location}.memory.representation`);
  if (!memory.delivery) add(diagnostics, "required_field", "Memory requires delivery", `${location}.memory.delivery`);
  if (memory.delivery?.type === "files" && "timing" in memory.delivery) {
    add(diagnostics, "undefined_memory_combination", "File delivery does not support automatic retrieval timing", `${location}.memory.delivery`);
  }
  if (memory.delivery?.type === "context-message" && (memory.delivery.role !== "user" || memory.delivery.placement !== "before-user-input")) {
    add(diagnostics, "adapter_incompatible", "Pi 0.85.1 supports context messages only as user-role before-user-input messages", `${location}.memory.delivery`);
  }
}

export function validateExperimentShape(experiment: ExperimentConfig, diagnostics: Diagnostic[]): void {
  if (experiment.schema_version !== 1) add(diagnostics, "schema_version", "experiment.schema_version must be 1", "experiment.schema_version");
  if (!experiment.id?.trim()) add(diagnostics, "required_field", "experiment.id is required", "experiment.id");
  const hasConditions = experiment.conditions !== undefined;
  const hasMatrix = experiment.matrix !== undefined;
  if (hasConditions && hasMatrix) add(diagnostics, "ambiguous_design", "Specify exactly one of conditions or matrix", "experiment");
  if (experiment.repetitions !== undefined && (!Number.isInteger(experiment.repetitions) || experiment.repetitions < 1)) {
    add(diagnostics, "invalid_repetitions", "repetitions must be a positive integer", "experiment.repetitions");
  }
  if (experiment.conditions) uniqueIds(diagnostics, experiment.conditions, "experiment.conditions");
  if (experiment.matrix?.axes) {
    const paths = Object.keys(experiment.matrix.axes);
    if (paths.length === 0) add(diagnostics, "invalid_matrix", "matrix.axes cannot be empty", "experiment.matrix.axes");
    for (const [index, path] of paths.entries()) {
      if (!MATRIX_PATHS.has(path)) {
        add(diagnostics, "invalid_axis", `Matrix path ${path} is not an agent field`, `experiment.matrix.axes.${path}`);
      }
      for (const other of paths.slice(index + 1)) {
        if (path.startsWith(`${other}.`) || other.startsWith(`${path}.`)) {
          add(diagnostics, "overlapping_axes", `Matrix axes ${path} and ${other} overlap`, "experiment.matrix.axes");
        }
      }
      const values = experiment.matrix.axes[path] ?? [];
      if (values.length === 0) add(diagnostics, "invalid_axis", `Matrix axis ${path} has no values`, `experiment.matrix.axes.${path}`);
      uniqueIds(diagnostics, values, `experiment.matrix.axes.${path}`);
    }
  }
  const execution = experiment.execution;
  if (execution?.concurrency !== undefined && (!Number.isInteger(execution.concurrency) || execution.concurrency < 1)) {
    add(diagnostics, "invalid_concurrency", "execution.concurrency must be a positive integer", "experiment.execution.concurrency");
  }
}

export function validateBaseline(config: BaselineConfig, diagnostics: Diagnostic[], location = "baseline"): void {
  if (config.schema_version !== 1) add(diagnostics, "schema_version", `${location}.schema_version must be 1`, `${location}.schema_version`);
  if (config.pi_version !== "0.85.1") add(diagnostics, "pi_version", `${location}.pi_version must be exactly 0.85.1`, `${location}.pi_version`);
  if (config.resources?.ambient_discovery !== false) {
    add(diagnostics, "ambient_resources", "resources.ambient_discovery must be false", `${location}.resources.ambient_discovery`);
  }
  if (!isPlainObject(config.session?.compaction) || typeof config.session.compaction.enabled !== "boolean") {
    add(diagnostics, "invalid_session", "session.compaction.enabled must be boolean", `${location}.session.compaction.enabled`);
  }
  if (config.limits?.wall_clock_ms !== undefined && (!Number.isInteger(config.limits.wall_clock_ms) || config.limits.wall_clock_ms < 1)) {
    add(diagnostics, "invalid_limit", "limits.wall_clock_ms must be a positive integer", `${location}.limits.wall_clock_ms`);
  }
  if (config.limits?.max_model_calls !== undefined && (!Number.isInteger(config.limits.max_model_calls) || config.limits.max_model_calls < 1)) {
    add(diagnostics, "invalid_limit", "limits.max_model_calls must be a positive integer", `${location}.limits.max_model_calls`);
  }
  if (
    !isPlainObject(config.session?.retries) ||
    typeof config.session.retries.enabled !== "boolean" ||
    !Number.isInteger(config.session.retries.max_retries) ||
    config.session.retries.max_retries < 0
  ) {
    add(diagnostics, "invalid_session", "session.retries requires enabled and nonnegative max_retries", `${location}.session.retries`);
  }
  for (const [name, value] of [
    ["reserve_tokens", config.session?.compaction?.reserve_tokens],
    ["keep_recent_tokens", config.session?.compaction?.keep_recent_tokens],
    ["base_delay_ms", config.session?.retries?.base_delay_ms],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      add(diagnostics, "invalid_session", `${name} must be a nonnegative integer`, `${location}.session.${name}`);
    }
  }
  validateModel(config, diagnostics, location);
  validateTools(config, diagnostics, location);
  validatePrompt(config, diagnostics, location);
  validateMemory(config, diagnostics, location);
}

export function validateScenarios(scenarios: ScenarioConfig[], diagnostics: Diagnostic[]): void {
  uniqueIds(diagnostics, scenarios, "scenarios");
  for (const scenario of scenarios) {
    const location = `scenario:${scenario.id || scenario.source_path}`;
    if (scenario.schema_version !== 1) add(diagnostics, "schema_version", `${location}.schema_version must be 1`, `${location}.schema_version`);
    if (!scenario.id?.trim()) add(diagnostics, "required_field", `${location}.id is required`, `${location}.id`);
    if (!scenario.steps || scenario.steps.length === 0) add(diagnostics, "required_field", `${location}.steps cannot be empty`, `${location}.steps`);
    else {
      uniqueIds(diagnostics, scenario.steps, `${location}.steps`);
      for (const [index, step] of scenario.steps.entries()) {
        if (typeof step.input !== "string" || step.input.length === 0) add(diagnostics, "invalid_input", "Scenario input must be non-empty text", `${location}.steps[${index}].input`);
      }
    }
    if (!["shared", "fresh-per-step"].includes(scenario.conversation)) add(diagnostics, "invalid_scenario", `${location}.conversation is invalid`, `${location}.conversation`);
    if (!["carry", "reset"].includes(scenario.memory_between_steps)) add(diagnostics, "invalid_scenario", `${location}.memory_between_steps is invalid`, `${location}.memory_between_steps`);
  }
}

export function customModuleEntries(config: BaselineConfig): Array<{ kind: string; module: string; export?: string }> {
  const entries: Array<{ kind: string; module: string; export?: string }> = [];
  for (const tool of config.tools?.entries ?? []) {
    if (tool.source === "custom" && tool.module) entries.push({ kind: `tool:${tool.name}`, module: tool.module, ...(tool.export ? { export: tool.export } : {}) });
  }
  for (const [kind, strategy] of [["memory-retrieval", config.memory?.retrieval], ["memory-representation", config.memory?.representation]] as const) {
    if (strategy?.type === "custom") entries.push({ kind, module: strategy.module, ...(strategy.export ? { export: strategy.export } : {}) });
  }
  return entries;
}

export function findTool(config: BaselineConfig, name: string): ToolEntryConfig | undefined {
  return config.tools.entries?.find((entry) => entry.name === name);
}
