import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PI_VERSION } from "../types.js";
import { pathExists } from "../util/fs.js";

const FILES: Record<string, string> = {
  "experiment.yaml": `# Experiment design. Choose either conditions or matrix (not both).
schema_version: 1
id: example-study
base: ./baseline.yaml

conditions:
  - id: baseline
    overrides: {}

scenarios:
  - ./scenarios/example.yaml

repetitions: 1
execution:
  concurrency: 1
  order: declared # or randomized
  seed: 1
  failure_policy: continue
`,
  "baseline.yaml": `# Pinned Pi baseline. An explicit provider/model selection is required.
schema_version: 1
pi_version: ${PI_VERSION}

model:
  provider: CHOOSE_ME
  id: CHOOSE_ME
  thinking: off
  # settings:
  #   temperature: 0
  #   max_tokens: 4096

tools:
  mode: pi-default # pi-default | replace | extend

system_prompt:
  mode: pi-default # pi-default | append | replace

# memory:
#   contents: ./memory/example.md
#   retrieval: {type: all}
#   representation: {type: verbatim}
#   delivery: {type: system-prompt, timing: once-per-user-input}
#   mutability: read-only

session:
  compaction: {enabled: true, reserve_tokens: 16384, keep_recent_tokens: 20000}
  retries:
    enabled: true
    max_retries: 3
    base_delay_ms: 2000
    provider: {max_retry_delay_ms: 60000}

resources:
  ambient_discovery: false

limits:
  wall_clock_ms: 300000
  max_model_calls: 100
`,
  "models/example.yaml": `# Reference this as: model: {from: ./models/example.yaml}
provider: CHOOSE_ME
id: CHOOSE_ME
thinking: off
`,
  "scenarios/example.yaml": `schema_version: 1
id: example
conversation: shared
memory_between_steps: carry
steps:
  - id: first
    input: "Inspect the workspace and summarize what you find."
`,
  "memory/.gitkeep": "",
  "prompts/.gitkeep": "",
  "tools/.gitkeep": "",
  "fixtures/.gitkeep": "",
  "experiment.lock.json": `${JSON.stringify({
    schema_version: 1,
    runner: "agent-study@0.1.0",
    pi: `@earendil-works/pi-coding-agent@${PI_VERSION}`,
    ambient_discovery: false,
  }, null, 2)}\n`,
  ".gitignore": `results/
*.plan.json
.DS_Store
`,
};

export async function initializeExperiment(directory: string): Promise<string[]> {
  const root = path.resolve(directory);
  const conflicts: string[] = [];
  for (const relative of Object.keys(FILES)) {
    if (await pathExists(path.join(root, relative))) conflicts.push(relative);
  }
  if (conflicts.length > 0) throw new Error(`Refusing to overwrite existing files: ${conflicts.join(", ")}`);
  for (const [relative, content] of Object.entries(FILES)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, { encoding: "utf8", flag: "wx" });
  }
  return Object.keys(FILES);
}
