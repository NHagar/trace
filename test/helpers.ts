import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function temporaryDirectory(prefix = "trace-test-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

export function baselineYaml(options: {
  tools?: string;
  memory?: string;
  prompt?: string;
  limits?: string;
  model?: string;
  session?: string;
} = {}): string {
  return `schema_version: 1
pi_version: 0.85.1
model: ${options.model ?? "{from: ./models/model.yaml}"}
tools:
${options.tools ?? "  mode: pi-default"}
system_prompt:
${options.prompt ?? "  mode: pi-default"}
${options.memory ?? ""}session:
${options.session ?? "  compaction: {enabled: true}\n  retries: {enabled: true, max_retries: 2}"}
resources:
  ambient_discovery: false
limits:
${options.limits ?? "  wall_clock_ms: 10000\n  max_model_calls: 20"}
`;
}

export const fixtureModelYaml = `provider: fixture
id: scripted
thinking: off
fixture:
  responses: ./responses.json
capabilities:
  reasoning: false
  settings: [max_tokens]
`;

export async function basicProject(options: {
  experiment?: string;
  baseline?: string;
  scenario?: string;
  responses?: unknown[];
  extra?: Record<string, string>;
} = {}): Promise<string> {
  const root = await temporaryDirectory();
  await writeFiles(root, {
    "experiment.yaml": options.experiment ?? `schema_version: 1
id: test-study
base: ./baseline.yaml
scenarios: [./scenarios/example.yaml]
repetitions: 1
`,
    "baseline.yaml": options.baseline ?? baselineYaml(),
    "models/model.yaml": fixtureModelYaml,
    "models/responses.json": `${JSON.stringify({ responses: options.responses ?? [{ text: "done" }] }, null, 2)}\n`,
    "scenarios/example.yaml": options.scenario ?? `schema_version: 1
id: example
conversation: shared
memory_between_steps: carry
steps:
  - {id: one, input: "Hello"}
`,
    ...(options.extra ?? {}),
  });
  return root;
}
