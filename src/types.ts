export const SCHEMA_VERSION = 1 as const;
export const PI_VERSION = "0.85.1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
}

export interface ModelConfig {
  provider: string;
  id: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  settings?: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
  };
  fixture?: {
    responses: string;
    context_window?: number;
    tokens_per_second?: number;
  };
  capabilities?: {
    reasoning?: boolean;
    settings?: Array<"temperature" | "max_tokens" | "top_p">;
  };
}

export interface ToolEntryConfig {
  name: string;
  source: "pi-builtin" | "custom" | "fixture" | "memory";
  builtin?: string;
  module?: string;
  export?: string;
  fixture?: string;
  description?: string;
  parameters?: JsonObject;
  replace?: boolean;
  config?: JsonObject;
}

export interface ToolRegistryConfig {
  mode: "pi-default" | "replace" | "extend";
  remove?: string[];
  entries?: ToolEntryConfig[];
}

export interface ModuleStrategy {
  type: "custom";
  module: string;
  export?: string;
  factory?: boolean;
  config?: JsonObject;
}

export interface MemoryConfig {
  contents?: string;
  retrieval?: { type: "all" } | ModuleStrategy;
  representation?:
    | { type: "verbatim" | "markdown-records" | "json-records" }
    | ModuleStrategy;
  delivery?:
    | { type: "system-prompt"; timing?: "once-per-user-input" | "before-every-model-call" }
    | {
        type: "context-message";
        role: "user";
        placement: "before-user-input";
        timing?: "once-per-user-input" | "before-every-model-call";
      }
    | { type: "tool"; name: string }
    | { type: "files"; destination?: string };
  mutability?: "read-only" | "writable";
}

export interface SystemPromptConfig {
  mode: "pi-default" | "append" | "replace";
  file?: string;
  text?: string;
}

export interface BaselineConfig {
  schema_version: 1;
  pi_version: string;
  model?: ModelConfig;
  tools: ToolRegistryConfig;
  system_prompt: SystemPromptConfig;
  memory?: MemoryConfig;
  session: {
    compaction: { enabled: boolean; reserve_tokens?: number; keep_recent_tokens?: number };
    retries: {
      enabled: boolean;
      max_retries: number;
      base_delay_ms?: number;
      provider?: { timeout_ms?: number; max_retries?: number; max_retry_delay_ms?: number };
    };
  };
  resources: { ambient_discovery: false };
  limits?: { wall_clock_ms?: number; max_model_calls?: number };
}

export interface ScenarioStep {
  id: string;
  input: string;
}

export interface ScenarioConfig {
  schema_version: 1;
  id: string;
  workspace?: { fixtures?: string };
  conversation: "shared" | "fresh-per-step";
  memory_between_steps: "carry" | "reset";
  steps: ScenarioStep[];
  source_path: string;
}

export interface ExplicitCondition {
  id: string;
  overrides: Record<string, unknown>;
}

export interface AxisValue {
  id: string;
  value: unknown;
}

export interface ExperimentConfig {
  schema_version: 1;
  id: string;
  base: string;
  conditions?: ExplicitCondition[];
  matrix?: { axes: Record<string, AxisValue[]> };
  scenarios: string[];
  repetitions?: number;
  allow_duplicate_conditions?: boolean;
  execution?: {
    concurrency?: number;
    order?: "declared" | "randomized";
    seed?: number;
    failure_policy?: "continue" | "stop";
  };
}

export interface ResolvedCondition {
  id: string;
  mapping: Record<string, string>;
  config: BaselineConfig;
  config_hash: string;
}

export interface PlannedRun {
  run_id: string;
  condition_id: string;
  scenario_id: string;
  repetition: number;
  seed: number;
}

export interface ContentHash {
  path: string;
  sha256: string;
  size: number;
}

export interface ExecutionPlan {
  schema_version: 1;
  plan_version: 2;
  experiment_id: string;
  execution_id: string;
  created_at: string;
  root: string;
  authored: {
    experiment: ExperimentConfig;
    baseline: unknown;
  };
  runtime: {
    node: string;
    runner: string;
    pi: string;
    dependency_lock_sha256?: string;
  };
  content_hashes: ContentHash[];
  directory_contents: Array<{ path: string; files: string[] }>;
  conditions: ResolvedCondition[];
  scenarios: ScenarioConfig[];
  runs: PlannedRun[];
  execution: Required<NonNullable<ExperimentConfig["execution"]>>;
  warnings: string[];
  plan_hash: string;
}

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "limit_reached";

export interface RunResult {
  run_id: string;
  status: RunStatus;
  error?: string;
  model_calls: number;
  started_at: string;
  finished_at: string;
}

export interface MemoryRecord {
  id: string;
  content: string;
  metadata?: JsonObject;
  source?: string;
}

export interface MemorySelection {
  records: MemoryRecord[];
}

export interface RenderedMemory {
  text: string;
  files?: Array<{ path: string; content: string }>;
}

export interface RetrievalInput {
  conversation: unknown[];
  query?: string;
  step_id?: string;
}

export interface RunContext {
  identity: PlannedRun & { execution_id: string };
  experiment_root: string;
  workspace: string;
  random: () => number;
  signal: AbortSignal;
  record: (type: string, data?: Record<string, unknown>) => Promise<void>;
  recorded_client: {
    complete(request: {
      provider?: string;
      model?: string;
      prompt: string;
      system_prompt?: string;
      thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    }): Promise<unknown>;
  };
}

export interface MemoryRetriever {
  retrieve(input: RetrievalInput, ctx: RunContext): Promise<MemorySelection>;
}

export interface MemoryRenderer {
  render(selection: MemorySelection, ctx: RunContext): Promise<RenderedMemory>;
}
