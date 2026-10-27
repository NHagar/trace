import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repository = fileURLToPath(new URL("..", import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), "trace-package-"));
const consumer = path.join(temporary, "consumer");
const npmCli = process.env.npm_execpath;
assert(npmCli, "Run this check with npm run test:package");
const env = { ...process.env, npm_config_cache: path.join(temporary, "cache") };

async function command(executable, args, cwd = repository, expectedCode = 0) {
  let result;
  try {
    result = await execFileAsync(executable, args, { cwd, env, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });
    assert.equal(expectedCode, 0, "Expected this command to fail");
  } catch (error) {
    if (expectedCode === 0 || error.code !== expectedCode) {
      process.stderr.write(error.stdout ?? "");
      process.stderr.write(error.stderr ?? "");
      throw error;
    }
    result = { stdout: error.stdout, stderr: error.stderr };
  }
  return result;
}

const npm = (args, cwd, expectedCode) => command(process.execPath, [npmCli, ...args], cwd, expectedCode);
const trace = (args, expectedCode) => npm(["exec", "--offline", "--", "trace", ...args], consumer, expectedCode);
const json = async (file) => JSON.parse(await readFile(file, "utf8"));

try {
  console.log("Packing the release archive (including a fresh build)…");
  const packed = await npm(["pack", "--json", "--pack-destination", temporary]);
  const [archive] = JSON.parse(packed.stdout);
  assert.equal(archive.name, "@nhagar/trace");
  const included = archive.files.map((file) => file.path);
  for (const required of ["dist/index.js", "dist/index.d.ts", "dist/execution/worker.js", "npm-shrinkwrap.json", "README.md", "LICENSE", "examples/memory-comparison/experiment.yaml"]) {
    assert(included.includes(required), `Package is missing ${required}`);
  }
  assert(included.every((file) => /^(dist\/|examples\/memory-comparison\/|package\.json$|npm-shrinkwrap\.json$|README\.md$|LICENSE$)/.test(file)), "Package contains unexpected files");

  await mkdir(consumer);
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  console.log("Installing the archive into a clean consumer project…");
  await npm(["install", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", path.join(temporary, archive.filename)], consumer);
  const installed = path.join(consumer, "node_modules", "@nhagar", "trace");
  assert(!(await readdir(installed)).includes("src"), "Smoke test must use compiled package files only");

  console.log("Checking the installed command, starter, and offline example…");
  assert.match((await trace(["--help"])).stdout, /trace init/);
  assert.equal((await trace(["--version"])).stdout.trim(), archive.version);
  await trace(["init", "./starter"]);
  const starter = await json(path.join(consumer, "starter", "experiment.lock.json"));
  assert.equal(starter.runner, `@nhagar/trace@${archive.version}`);
  const invalid = await trace(["check", "./starter", "--json"], 1);
  assert.equal(JSON.parse(invalid.stdout).valid, false, "Starter should require an explicit model choice");

  await cp(path.join(installed, "examples", "memory-comparison"), path.join(consumer, "example"), { recursive: true });
  const checked = JSON.parse((await trace(["check", "./example", "--json", "--write-plan", "./example.plan.json"])).stdout);
  assert.equal(checked.valid, true);
  assert.equal(checked.plan.runs.length, 4);
  assert(!checked.diagnostics.some((item) => item.code === "missing_lockfile"));
  const lockHash = createHash("sha256").update(await readFile(path.join(installed, "npm-shrinkwrap.json"))).digest("hex");
  assert.equal(checked.plan.runtime.dependency_lock_sha256, lockHash, "Installed dependency lock must be recorded");

  await trace(["run", "--plan", "./example.plan.json", "--output", "./results", "--concurrency", "2"]);
  const manifest = await json(path.join(consumer, "results", "manifest.json"));
  assert.equal(Object.keys(manifest.statuses).length, 4);
  assert(Object.values(manifest.statuses).every((status) => status === "completed"));
  for (const runId of Object.keys(manifest.statuses)) {
    const run = path.join(consumer, "results", "runs", runId);
    assert.equal((await json(path.join(run, "final-state.json"))).status, "completed");
    const events = (await readFile(path.join(run, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert(events.some((event) => event.type === "tool_execution_start"), "Worker must execute fixture tools");
    assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  }

  console.log("Checking the installed JavaScript API and TypeScript declarations…");
  await command(process.execPath, ["--input-type=module", "-e", `import assert from "node:assert/strict"; import {planExperiment} from "@nhagar/trace"; const checked = await planExperiment("./example"); assert.equal(checked.plan.runs.length, 4);`], consumer);
  await writeFile(path.join(consumer, "consumer.ts"), `import {planExperiment, type ExecutionPlan} from "@nhagar/trace";\nconst result = await planExperiment("./example");\nconst plan: ExecutionPlan | undefined = result.plan;\nvoid plan;\n`);
  await command(process.execPath, [path.join(repository, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--module", "NodeNext", "--target", "ES2022", "--skipLibCheck", "consumer.ts"], consumer);

  console.log(`Package check passed: ${archive.name}@${archive.version}, ${archive.entryCount} files, ${archive.size} bytes. All 4 installed-package trials completed.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
