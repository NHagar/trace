import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planExperiment, validateSavedPlan } from "../src/planner/plan.js";
import { baselineYaml, basicProject, fixtureModelYaml, writeFiles } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("configuration and planning", () => {
  it("expands a 2 × 3 matrix, two scenarios, and ten repetitions to 120 unique runs", async () => {
    const root = await basicProject();
    await writeFiles(root, {
      "models/a.yaml": fixtureModelYaml.replace("id: scripted", "id: a"),
      "models/b.yaml": fixtureModelYaml.replace("id: scripted", "id: b"),
      "memory/neutral.md": "neutral",
      "memory/academic.md": "academic",
      "memory/news.md": "news",
      "scenarios/a.yaml": `schema_version: 1\nid: a\nconversation: shared\nmemory_between_steps: carry\nsteps: [{id: one, input: a}]\n`,
      "scenarios/b.yaml": `schema_version: 1\nid: b\nconversation: shared\nmemory_between_steps: carry\nsteps: [{id: one, input: b}]\n`,
      "baseline.yaml": baselineYaml({ memory: `memory:\n  contents: ./memory/neutral.md\n  retrieval: {type: all}\n  representation: {type: verbatim}\n  delivery: {type: system-prompt}\n  mutability: read-only\n` }),
      "experiment.yaml": `schema_version: 1
id: matrix-120
base: ./baseline.yaml
matrix:
  axes:
    model:
      - {id: a, value: {from: ./models/a.yaml}}
      - {id: b, value: {from: ./models/b.yaml}}
    memory.contents:
      - {id: neutral, value: ./memory/neutral.md}
      - {id: academic, value: ./memory/academic.md}
      - {id: news, value: ./memory/news.md}
scenarios: [./scenarios/a.yaml, ./scenarios/b.yaml]
repetitions: 10
execution: {order: randomized, seed: 1234}
`,
    });
    const result = await planExperiment(root);
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(result.plan?.conditions).toHaveLength(6);
    expect(result.plan?.runs).toHaveLength(120);
    expect(new Set(result.plan?.runs.map((run) => run.run_id)).size).toBe(120);
  });

  it("resolves equivalent explicit conditions and matrix values identically", async () => {
    const root = await basicProject({
      baseline: baselineYaml({ memory: `memory:\n  contents: ./memory/a.md\n  retrieval: {type: all}\n  representation: {type: verbatim}\n  delivery: {type: system-prompt}\n  mutability: read-only\n` }),
      extra: { "memory/a.md": "a", "memory/b.md": "b" },
    });
    const experimentPath = path.join(root, "experiment.yaml");
    await writeFile(experimentPath, `schema_version: 1\nid: equivalence\nbase: ./baseline.yaml\nmatrix:\n  axes:\n    memory.contents:\n      - {id: a, value: ./memory/a.md}\n      - {id: b, value: ./memory/b.md}\nscenarios: [./scenarios/example.yaml]\n`, "utf8");
    const matrix = await planExperiment(root);
    await writeFile(experimentPath, `schema_version: 1\nid: equivalence\nbase: ./baseline.yaml\nconditions:\n  - {id: a, overrides: {memory: {contents: ./memory/a.md}}}\n  - {id: b, overrides: {memory: {contents: ./memory/b.md}}}\nscenarios: [./scenarios/example.yaml]\n`, "utf8");
    const explicit = await planExperiment(root);
    expect(matrix.plan?.conditions.map((item) => item.config_hash).sort()).toEqual(
      explicit.plan?.conditions.map((item) => item.config_hash).sort(),
    );
  });

  it("does not fetch or import custom modules during check", async () => {
    const root = await basicProject({
      baseline: baselineYaml({ tools: `  mode: replace\n  entries:\n    - {name: side_effect, source: custom, module: ./tools/side-effect.mjs}` }),
      extra: {
        "tools/side-effect.mjs": `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify("SIDE_EFFECT_MARKER")}, "ran"); export default () => ({name:"side_effect"});`,
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
    const result = await planExperiment(root);
    expect(result.plan).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(readFile("SIDE_EFFECT_MARKER", "utf8")).rejects.toThrow();
  });

  it("rejects overlapping axes, duplicate IDs, unknown fields, and incompatible model settings", async () => {
    const root = await basicProject({
      baseline: baselineYaml({ model: `{provider: fixture, id: x, thinking: high, capabilities: {reasoning: false}, mystery: true}` }),
      experiment: `schema_version: 1
id: invalid
base: ./baseline.yaml
matrix:
  axes:
    memory:
      - {id: same, value: {contents: ./x}}
      - {id: same, value: {contents: ./x}}
    memory.contents:
      - {id: x, value: ./x}
scenarios: [./scenarios/example.yaml]
`,
    });
    const result = await planExperiment(root);
    const codes = result.diagnostics.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining(["unknown_field", "duplicate_id", "overlapping_axes", "model_incompatible"]));
    expect(result.plan).toBeUndefined();
  });

  it("rejects a saved plan when a referenced fixture changes", async () => {
    const root = await basicProject();
    const plan = (await planExperiment(root)).plan!;
    await writeFile(path.join(root, "models", "responses.json"), '{"responses":[{"text":"changed"}]}\n', "utf8");
    const diagnostics = await validateSavedPlan(plan);
    expect(diagnostics.some((item) => item.code === "stale_plan" && item.path === "models/responses.json")).toBe(true);
  });

  it("rejects scenario IDs that collide after normalization", async () => {
    const root = await basicProject({
      experiment: "schema_version: 1\nid: collision\nbase: ./baseline.yaml\nscenarios: [./scenarios/one.yaml, ./scenarios/two.yaml]\n",
      extra: {
        "scenarios/one.yaml": "schema_version: 1\nid: Case\nconversation: shared\nmemory_between_steps: carry\nsteps: [{id: one, input: first}]\n",
        "scenarios/two.yaml": "schema_version: 1\nid: case\nconversation: shared\nmemory_between_steps: carry\nsteps: [{id: one, input: second}]\n",
      },
    });
    const result = await planExperiment(root);
    expect(result.plan).toBeUndefined();
    expect(result.diagnostics.some((item) => item.code === "duplicate_run_id")).toBe(true);
  });

  it("rejects saved plans when files are added to memory or workspace fixture directories", async () => {
    const root = await basicProject({
      baseline: baselineYaml({ memory: "memory:\n  contents: ./memory\n  retrieval: {type: all}\n  representation: {type: verbatim}\n  delivery: {type: system-prompt}\n" }),
      scenario: "schema_version: 1\nid: files\nworkspace: {fixtures: ../workspace}\nconversation: shared\nmemory_between_steps: carry\nsteps: [{id: one, input: hello}]\n",
      extra: { "memory/original.md": "original", "workspace/original.txt": "original" },
    });
    const plan = (await planExperiment(root)).plan!;
    expect(await validateSavedPlan(plan)).toEqual([]);
    await writeFiles(root, { "memory/nested/new.md": "new memory", "workspace/new.txt": "new fixture" });
    const diagnostics = await validateSavedPlan(plan);
    expect(diagnostics.filter((item) => item.code === "stale_plan").map((item) => item.path).sort()).toEqual(["memory", "workspace"]);
  });

  it("freezes initially empty input directories and rejects older saved-plan formats", async () => {
    const root = await basicProject({
      baseline: baselineYaml({ memory: "memory:\n  contents: ./memory\n  retrieval: {type: all}\n  representation: {type: verbatim}\n  delivery: {type: system-prompt}\n" }),
    });
    await mkdir(path.join(root, "memory"));
    const plan = (await planExperiment(root)).plan!;
    expect(await validateSavedPlan(plan)).toEqual([]);
    await writeFiles(root, { "memory/added.md": "new" });
    expect((await validateSavedPlan(plan)).some((item) => item.code === "stale_plan")).toBe(true);
    const old = JSON.parse(JSON.stringify(plan));
    old.plan_version = 1;
    delete old.directory_contents;
    expect((await validateSavedPlan(old))[0]?.message).toContain("format is outdated");
  });
});
