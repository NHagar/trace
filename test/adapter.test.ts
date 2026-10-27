import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { injectSystemMemory } from "../src/adapter/pi/payload.js";
import { executeTrial } from "../src/execution/worker.js";
import { planExperiment } from "../src/planner/plan.js";
import { readJson } from "../src/util/fs.js";
import type { RunResult } from "../src/types.js";
import { baselineYaml, basicProject, temporaryDirectory, writeFiles } from "./helpers.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

async function runSingle(root: string) {
  const checked = await planExperiment(root);
  expect(checked.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  const output = await temporaryDirectory("agent-study-output-");
  const result = await executeTrial({ plan: checked.plan!, run: checked.plan!.runs[0]!, output });
  return { result, output, plan: checked.plan! };
}

async function events(output: string, runId: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(output, "runs", runId, "events.jsonl"), "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Pi adapter and execution", () => {
  it("injects memory into Anthropic, Responses, and chat payload shapes", () => {
    expect(injectSystemMemory({ system: "base" }, "memory")).toEqual({ system: "base\n\n---\n\nmemory" });
    expect(injectSystemMemory({ instructions: "base" }, "memory")).toEqual({ instructions: "base\n\n---\n\nmemory" });
    expect(injectSystemMemory({ messages: [{ role: "system", content: "base" }] }, "memory")).toEqual({
      messages: [{ role: "system", content: "base\n\n---\n\nmemory" }],
    });
  });

  it("keeps shared history and omits it for fresh-per-step sessions", async () => {
    const sharedRoot = await basicProject({
      responses: [{ text: "first answer" }, { text: "second answer" }],
      scenario: `schema_version: 1\nid: dialogue\nconversation: shared\nmemory_between_steps: carry\nsteps:\n  - {id: one, input: first}\n  - {id: two, input: second}\n`,
    });
    const shared = await runSingle(sharedRoot);
    const sharedEvents = await events(shared.output, shared.plan.runs[0]!.run_id);
    const sharedSecond = sharedEvents.filter((event) => event.type === "effective_model_request")[1]!;
    expect(JSON.stringify(sharedSecond)).toContain("first answer");

    const freshRoot = await basicProject({
      responses: [{ text: "first answer" }, { text: "second answer" }],
      scenario: `schema_version: 1\nid: dialogue\nconversation: fresh-per-step\nmemory_between_steps: carry\nsteps:\n  - {id: one, input: first}\n  - {id: two, input: second}\n`,
    });
    const fresh = await runSingle(freshRoot);
    const freshEvents = await events(fresh.output, fresh.plan.runs[0]!.run_id);
    const freshSecond = freshEvents.filter((event) => event.type === "effective_model_request")[1]!;
    expect(JSON.stringify(freshSecond)).not.toContain("first answer");
  });

  it("implements prompt modes and system, context, and file memory delivery at the adapter boundary", async () => {
    for (const [mode, expected] of [["append", "APPENDED INSTRUCTION"], ["replace", "REPLACEMENT INSTRUCTION"]] as const) {
      const root = await basicProject({
        baseline: baselineYaml({ prompt: `  mode: ${mode}\n  text: ${expected}` }),
      });
      const completed = await runSingle(root);
      const recorded = await events(completed.output, completed.plan.runs[0]!.run_id);
      const promptEvent = recorded.find((event) => event.type === "system_prompt")!;
      const generated = promptEvent.configured_effective as string;
      expect(generated).toContain(expected);
      if (mode === "replace") expect(generated).toBe(expected);
      else expect(generated).toContain("expert coding assistant");
    }

    const makeMemory = async (delivery: string) => basicProject({
      baseline: baselineYaml({
        memory: `memory:\n  contents: ./memory/note.md\n  retrieval: {type: all}\n  representation: {type: verbatim}\n  delivery: ${delivery}\n  mutability: read-only\n`,
      }),
      extra: { "memory/note.md": "MEMORY SENTINEL" },
    });
    const system = await runSingle(await makeMemory("{type: system-prompt, timing: once-per-user-input}"));
    expect(JSON.stringify(await events(system.output, system.plan.runs[0]!.run_id))).toContain("MEMORY SENTINEL");

    const context = await runSingle(await makeMemory("{type: context-message, role: user, placement: before-user-input, timing: before-every-model-call}"));
    const contextRequest = (await events(context.output, context.plan.runs[0]!.run_id)).find((event) => event.type === "effective_model_request")!;
    const contextMessages = contextRequest.messages as Array<{ role: string; content: unknown }>;
    expect(contextMessages[0]?.role).toBe("custom");
    expect(JSON.stringify(contextMessages[0])).toContain("MEMORY SENTINEL");

    const files = await runSingle(await makeMemory("{type: files, destination: controlled-memory}"));
    const manifest = await readJson<{ initial: Array<{ path: string }> }>(path.join(files.output, "runs", files.plan.runs[0]!.run_id, "workspace-manifest.json"));
    expect(manifest.initial.map((entry) => entry.path)).toContain("controlled-memory/note.md");
  });

  it("carries and resets writable memory independently of conversation", async () => {
    const memoryBlock = `memory:\n  contents: ./memory/records.json\n  retrieval: {type: all}\n  representation: {type: json-records}\n  delivery: {type: tool, name: memory_search}\n  mutability: writable\n`;
    const tools = `  mode: replace\n  entries:\n    - {name: memory_search, source: memory}`;
    const responses = [
      { tool_call: { name: "memory_search", arguments: { action: "write", id: "new", content: "persist me" } } },
      { text: "written" },
      { text: "second" },
    ];
    const make = async (mode: "carry" | "reset") => basicProject({
      baseline: baselineYaml({ memory: memoryBlock, tools }),
      responses,
      scenario: `schema_version: 1\nid: memory\nconversation: fresh-per-step\nmemory_between_steps: ${mode}\nsteps:\n  - {id: one, input: write}\n  - {id: two, input: inspect}\n`,
      extra: { "memory/records.json": '{"records":[{"id":"original","content":"original"}]}\n' },
    });
    const carried = await runSingle(await make("carry"));
    const reset = await runSingle(await make("reset"));
    const carriedState = await readJson<{ memory: Array<{ id: string }> }>(path.join(carried.output, "runs", carried.plan.runs[0]!.run_id, "final-state.json"));
    const resetState = await readJson<{ memory: Array<{ id: string }> }>(path.join(reset.output, "runs", reset.plan.runs[0]!.run_id, "final-state.json"));
    expect(carriedState.memory.map((item) => item.id)).toContain("new");
    expect(resetState.memory.map((item) => item.id)).not.toContain("new");
  });

  it("records tool errors and model-call limits as distinct outcomes", async () => {
    const toolRoot = await basicProject({
      baseline: baselineYaml({ tools: `  mode: extend\n  entries:\n    - {name: fake_search, source: fixture, fixture: ./fixtures/tool.json}` }),
      responses: [
        { tool_call: { name: "fake_search", arguments: { query: "bad" } } },
        { text: "recovered from tool error" },
      ],
      extra: { "fixtures/tool.json": '{"error_for":["bad"]}\n' },
    });
    const toolRun = await runSingle(toolRoot);
    const toolEvents = await events(toolRun.output, toolRun.plan.runs[0]!.run_id);
    expect(toolRun.result.status).toBe("completed");
    expect(toolEvents.some((event) => event.type === "tool_execution_end" && JSON.stringify(event).includes('"isError":true'))).toBe(true);

    const limitRoot = await basicProject({
      baseline: baselineYaml({
        tools: `  mode: extend\n  entries:\n    - {name: fake_search, source: fixture, fixture: ./fixtures/tool.json}`,
        limits: "  wall_clock_ms: 10000\n  max_model_calls: 1",
      }),
      responses: [
        { tool_call: { name: "fake_search", arguments: { query: "ok" } } },
        { tool_call: { name: "fake_search", arguments: { query: "should be blocked" } } },
        { text: "should be blocked" },
      ],
      extra: { "fixtures/tool.json": '{"default":"ok"}\n' },
    });
    const limited = await runSingle(limitRoot);
    expect(limited.result.status).toBe("limit_reached");
    expect(limited.result.model_calls).toBe(1);
    const limitedEvents = await events(limited.output, limited.plan.runs[0]!.run_id);
    expect(limitedEvents.filter((event) => event.type === "tool_execution_start")).toHaveLength(1);
    expect(limitedEvents.some((event) => event.type === "message_end" && JSON.stringify(event).includes("should be blocked"))).toBe(false);
    const finalState = await readJson<{ termination: string }>(path.join(limited.output, "runs", limited.plan.runs[0]!.run_id, "final-state.json"));
    expect(finalState.termination).toBe("model_calls");
  });

  it("classifies a timed-out model response as limit_reached", async () => {
    const root = await basicProject({
      baseline: baselineYaml({ limits: "  wall_clock_ms: 500\n  max_model_calls: 20" }),
      responses: [{ text: "slow response ".repeat(100) }],
      extra: { "models/model.yaml": "provider: fixture\nid: scripted\nfixture: {responses: ./responses.json, tokens_per_second: 50}\n" },
    });
    const limited = await runSingle(root);
    expect(limited.result.status).toBe("limit_reached");
    const state = await readJson<{ termination: string }>(path.join(limited.output, "runs", limited.result.run_id, "final-state.json"));
    expect(state.termination).toBe("wall_clock");
    expect((await events(limited.output, limited.result.run_id)).filter((event) => event.type === "limit_reached")).toHaveLength(1);
  });

  it("applies the deadline to file-memory initialization and cancels its helper request", async () => {
    const root = await basicProject({
      baseline: baselineYaml({
        limits: "  wall_clock_ms: 500\n  max_model_calls: 20",
        memory: "memory:\n  contents: ./memory.md\n  retrieval: {type: custom, module: ./retrieve.mjs}\n  representation: {type: verbatim}\n  delivery: {type: files}\n",
      }),
      responses: [{ text: "slow helper ".repeat(100) }],
      extra: {
        "models/model.yaml": "provider: fixture\nid: scripted\nfixture: {responses: ./responses.json, tokens_per_second: 50}\n",
        "memory.md": "memory",
        "retrieve.mjs": `export default async (input, ctx) => {await ctx.recorded_client.complete({prompt:"select"}); return {records:[]};};`,
      },
    });
    const limited = await runSingle(root);
    expect(limited.result.status).toBe("limit_reached");
    expect(limited.result.error).toContain("Wall-clock limit");
    expect((await events(limited.output, limited.result.run_id)).filter((event) => event.type === "session_created")).toHaveLength(0);
  });

  it("fails a run when custom memory stages throw, before sending a model request", async () => {
    for (const timing of ["once-per-user-input", "before-every-model-call"]) {
      const root = await basicProject({
        baseline: baselineYaml({ memory: `memory:\n  contents: ./memory.md\n  retrieval: {type: all}\n  representation: {type: custom, module: ./render.mjs}\n  delivery: {type: system-prompt, timing: ${timing}}\n` }),
        extra: {
          "memory.md": "required memory",
          "render.mjs": `export default async () => {throw new Error("memory stage failed");};`,
        },
      });
      const failed = await runSingle(root);
      expect(failed.result.status).toBe("failed");
      expect(failed.result.error).toContain("memory stage failed");
      expect(failed.result.model_calls).toBe(0);
      expect((await events(failed.output, failed.result.run_id)).filter((event) => event.type === "provider_payload")).toHaveLength(0);
    }
  });

  it("fails a run when a memory tool's retrieval stage throws", async () => {
    const root = await basicProject({
      baseline: baselineYaml({
        tools: "  mode: replace\n  entries:\n    - {name: memory_search, source: memory}",
        memory: "memory:\n  contents: ./memory.md\n  retrieval: {type: custom, module: ./retrieve.mjs}\n  representation: {type: verbatim}\n  delivery: {type: tool, name: memory_search}\n",
      }),
      responses: [{ tool_call: { name: "memory_search", arguments: { query: "test" } } }, { text: "must not continue" }],
      extra: { "memory.md": "required memory", "retrieve.mjs": `export default async () => {throw new Error("retrieval failed");};` },
    });
    const failed = await runSingle(root);
    expect(failed.result.status).toBe("failed");
    expect(failed.result.error).toContain("retrieval failed");
    expect(failed.result.model_calls).toBe(1);
  });

  it("counts retrieval-helper requests toward the same model-call budget", async () => {
    const root = await basicProject({
      baseline: baselineYaml({
        limits: "  wall_clock_ms: 5000\n  max_model_calls: 1",
        memory: "memory:\n  contents: ./memory.md\n  retrieval: {type: custom, module: ./retrieve.mjs}\n  representation: {type: verbatim}\n  delivery: {type: system-prompt}\n",
      }),
      responses: [{ text: "helper response" }, { text: "main response must be blocked" }],
      extra: {
        "memory.md": "memory",
        "retrieve.mjs": `export default async (input, ctx) => {await ctx.recorded_client.complete({prompt:"select"}); return {records:[]};};`,
      },
    });
    const limited = await runSingle(root);
    expect(limited.result.status).toBe("limit_reached");
    expect(limited.result.model_calls).toBe(1);
    const recorded = await events(limited.output, limited.result.run_id);
    expect(recorded.filter((event) => event.type === "memory_model_response")).toHaveLength(1);
    expect(recorded.some((event) => event.type === "message_end" && JSON.stringify(event).includes("main response must be blocked"))).toBe(false);
  });

  it("records Pi retry and overflow-compaction events without conflating them", async () => {
    const retryRoot = await basicProject({
      responses: [{ error: "rate limit: retry this request" }, { text: "retry succeeded" }],
    });
    const retried = await runSingle(retryRoot);
    const retryEvents = await events(retried.output, retried.plan.runs[0]!.run_id);
    expect(retried.result.status).toBe("completed");
    expect(retryEvents.some((event) => event.type === "auto_retry_start")).toBe(true);
    expect(retryEvents.some((event) => event.type === "auto_retry_end")).toBe(true);

    const compactRoot = await basicProject({
      baseline: baselineYaml({
        session: "  compaction: {enabled: true, reserve_tokens: 128, keep_recent_tokens: 1}\n  retries: {enabled: true, max_retries: 2, base_delay_ms: 1}",
      }),
      responses: [
        { text: "first turn establishes history" },
        { error: "context_length_exceeded: fixture overflow" },
        { text: "summary for compaction" },
        { text: "recovered after compaction" },
      ],
      scenario: `schema_version: 1\nid: compact\nconversation: shared\nmemory_between_steps: carry\nsteps:\n  - {id: one, input: first}\n  - {id: two, input: overflow now}\n`,
    });
    const compacted = await runSingle(compactRoot);
    const compactEvents = await events(compacted.output, compacted.plan.runs[0]!.run_id);
    expect(compactEvents.some((event) => event.type === "compaction_start")).toBe(true);
    expect(compactEvents.some((event) => event.type === "compaction_end")).toBe(true);
  });

  it("runs the release-gate example through Pi and records offered, opened, and cited sources", async () => {
    const output = await temporaryDirectory("agent-study-release-gate-");
    const cli = path.join(repositoryRoot, "dist", "cli", "index.js");
    const example = path.join(repositoryRoot, "examples", "memory-comparison");
    const result = await execFileAsync(process.execPath, [cli, "run", example, "--output", output], { timeout: 30_000 });
    expect(result.stdout).toContain("4/4 runs completed");
    const manifest = await readJson<{ statuses: Record<string, string> }>(path.join(output, "manifest.json"));
    expect(Object.values(manifest.statuses)).toEqual(["completed", "completed", "completed", "completed"]);
    const firstRun = Object.keys(manifest.statuses)[0]!;
    const recorded = await events(output, firstRun);
    expect(recorded.some((event) => event.type === "tool_execution_start" && JSON.stringify(event).includes("fake_search"))).toBe(true);
    expect(JSON.stringify(recorded)).toContain("Lewis et al., 2020");
    const sessionCreated = recorded.find((event) => event.type === "session_created")!;
    expect(sessionCreated.ambient_resources).toEqual({ extensions: [], skills: [], context_files: [], prompts: [] });
  });

  it("isolates custom module state between repetitions by using worker processes", async () => {
    const root = await basicProject({
      experiment: `schema_version: 1\nid: isolation\nbase: ./baseline.yaml\nscenarios: [./scenarios/example.yaml]\nrepetitions: 2\n`,
      baseline: baselineYaml({ tools: `  mode: replace\n  entries:\n    - {name: counter, source: custom, module: ./tools/counter.mjs}` }),
      responses: [
        { tool_call: { name: "counter", arguments: {} } },
        { text: "done" },
      ],
      extra: {
        "tools/counter.mjs": `let count = 0; export default () => ({ name: "counter", label: "counter", description: "counter", parameters: {type:"object",properties:{}}, execute: async () => ({content:[{type:"text",text:String(++count)}],details:{count}}) });\n`,
      },
    });
    const output = await temporaryDirectory("agent-study-isolation-");
    const cli = path.join(repositoryRoot, "dist", "cli", "index.js");
    await execFileAsync(process.execPath, [cli, "run", root, "--output", output, "--concurrency", "2"], { timeout: 30_000 });
    const runDirs = (await import("node:fs/promises")).readdir(path.join(output, "runs"));
    for (const runId of await runDirs) {
      const recorded = await events(output, runId);
      const toolEnd = recorded.find((event) => event.type === "tool_execution_end")!;
      expect(JSON.stringify(toolEnd)).toContain('"text":"1"');
    }
  });

  it("retains completed records and readable partial JSONL when a batch is interrupted", async () => {
    const root = await basicProject({
      experiment: `schema_version: 1
id: interrupted
base: ./baseline.yaml
conditions:
  - {id: fast, overrides: {model: {from: ./models/fast.yaml}}}
  - {id: slow, overrides: {model: {from: ./models/slow.yaml}}}
scenarios: [./scenarios/example.yaml]
execution: {concurrency: 1, order: declared, failure_policy: continue}
`,
      extra: {
        "models/fast.yaml": `provider: fixture\nid: fast\nthinking: off\nfixture: {responses: ./fast.json}\ncapabilities: {reasoning: false}\n`,
        "models/slow.yaml": `provider: fixture\nid: slow\nthinking: off\nfixture: {responses: ./slow.json, tokens_per_second: 20}\ncapabilities: {reasoning: false}\n`,
        "models/fast.json": '{"responses":[{"text":"fast done"}]}\n',
        "models/slow.json": `${JSON.stringify({ responses: [{ text: "slow ".repeat(2_000) }] })}\n`,
      },
    });
    const output = await temporaryDirectory("agent-study-interrupt-");
    const cli = path.join(repositoryRoot, "dist", "cli", "index.js");
    const child = spawn(process.execPath, [cli, "run", root, "--output", output], { stdio: "ignore" });
    const manifestPath = path.join(output, "manifest.json");
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        const manifest = await readJson<{ statuses: Record<string, string> }>(manifestPath);
        if (Object.values(manifest.statuses).includes("completed")) break;
      } catch {
        // The manifest is created atomically while workers start.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill("SIGINT");
    const exit = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(exit).not.toBe(0);
    const manifest = await readJson<{ statuses: Record<string, string> }>(manifestPath);
    expect(Object.values(manifest.statuses)).toContain("completed");
    expect(Object.values(manifest.statuses)).toContain("interrupted");
    const interruptedRun = Object.entries(manifest.statuses).find(([, status]) => status === "interrupted")?.[0];
    expect(interruptedRun).toBeDefined();
    const partial = await readFile(path.join(output, "runs", interruptedRun!, "events.jsonl"), "utf8");
    expect(() => partial.trim().split("\n").filter(Boolean).forEach((line) => JSON.parse(line))).not.toThrow();
  });
});
