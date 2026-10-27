# trace

**Run controlled experiments with coding agents and see what happened.**

trace helps you compare how agents behave when you change their model, prompts, tools, or memory. You define the tasks and conditions; trace runs each trial in its own workspace and records the conversation, model requests, tool calls, memory activity, and file changes.

Use it to study questions such as “Does this memory change which sources an agent chooses?” or “How does tool access affect the way an agent approaches a task?” You can explore behavior without supplying a correct answer or a numerical score.

trace uses the [Pi coding-agent SDK](https://github.com/earendil-works/pi/tree/main/packages/coding-agent), pinned to version **0.85.1**.

## Install

You need **Node.js 22.19 or newer** and npm.

Install the public package:

```sh
npm install --global @nhagar/trace
trace --help
```

The package is named `@nhagar/trace`; the command is `trace`. Until the first npm release, use the source installation below.

To run a command without installing globally:

```sh
npx --package=@nhagar/trace trace --help
```

### Install from source

```sh
git clone https://github.com/NHagar/trace.git
cd trace
npm ci
npm run build
npm link
```

`npm link` makes the `trace` command available in your terminal. You can also run commands directly with `node dist/cli/index.js` in place of `trace`.

## Try the included example

Start with an offline experiment. It uses scripted model responses and fixed search results, so you can try the full workflow without an API key.

```sh
trace check ./examples/memory-comparison
trace run ./examples/memory-comparison --output ./results/demo
```

This runs **4 trials**: two memory conditions, each repeated twice. When it finishes, open `results/demo/manifest.json` for the run statuses and `results/demo/runs/` for the detailed records.

The responses in this example are prerecorded. It demonstrates the workflow and output format; choose a live model for your own behavioral experiments.

These paths assume a source checkout. With a global npm installation, the bundled example is at `$(npm root --global)/@nhagar/trace/examples/memory-comparison`:

```sh
trace run "$(npm root --global)/@nhagar/trace/examples/memory-comparison" --output ./results/demo
```

Use a new output directory when running the example again, such as `./results/demo-2`.

## Create your own experiment

### 1. Generate a starter project

```sh
trace init ./my-experiment
```

The starter includes:

| File or folder | What you put there |
| --- | --- |
| `experiment.yaml` | Conditions, scenarios, repetitions, and execution order |
| `baseline.yaml` | The agent settings shared by all conditions |
| `scenarios/` | Tasks and conversation steps for the agent |
| `models/` | Optional model configurations you can reference from the baseline |
| `memory/`, `prompts/`, `tools/`, `fixtures/` | Supporting files for your experiment |
| `experiment.lock.json` | Runner and Pi version information |

`init` creates editable files and refuses to overwrite an existing starter.

### 2. Choose a model

In `my-experiment/baseline.yaml`, replace the `CHOOSE_ME` values under `model` with a provider and model supported by the pinned Pi catalog. For example:

```yaml
model:
  provider: openai
  id: gpt-4.1
  thinking: off
```

Provide credentials through the provider's environment variables or your existing Pi authentication. For this OpenAI example, set `OPENAI_API_KEY` in your environment. Keep credentials outside experiment files.

Edit `scenarios/example.yaml` to set the task you want the agent to perform. A scenario can contain one prompt or several conversation steps.

### 3. Check and run

```sh
trace check ./my-experiment
trace run ./my-experiment
```

`check` validates the configuration and shows how many trials will run. It performs local checks without importing custom code or contacting a model. Credentials and remote model availability are checked when you run the experiment.

By default, results go to `my-experiment/results/<execution-id>/`. To choose a location:

```sh
trace run ./my-experiment --output ./results/first-study
```

The output directory must be empty. Existing executions cannot be overwritten or resumed.

## Compare conditions

A **baseline** defines the shared agent settings. A **condition** changes some of those settings. A **scenario** defines the task. A **repetition** runs the same condition and scenario again in a fresh trial.

For example, replace the starter's `experiment.yaml` with this to compare the baseline against an extra instruction to cite sources:

```yaml
schema_version: 1
id: source-selection
base: ./baseline.yaml

conditions:
  - id: baseline
    overrides: {}
  - id: ask-for-sources
    overrides:
      system_prompt:
        mode: append
        text: Cite the sources you use in your answer.

scenarios:
  - ./scenarios/example.yaml

repetitions: 5
execution:
  concurrency: 1
  order: randomized
  seed: 1234
  failure_policy: continue
```

This creates **10 trials**: 2 conditions × 1 scenario × 5 repetitions. Objects merge with the baseline; arrays and individual values replace inherited values.

For larger designs, use `matrix.axes` instead of `conditions` to run every combination of settings. Each axis lists `{id, value}` entries for a setting such as `model` or `memory.contents`. Axes cannot overlap—for example, a matrix cannot vary both `model` and `model.id`.

## Read the results

Each execution saves a summary, its plan, copies of the referenced input files, and a folder for every trial:

```text
<execution-directory>/
  manifest.json
  plan.json
  assets/
  runs/<run-id>/
    config.json
    events.jsonl
    messages.json
    final-state.json
    workspace-manifest.json
    artifacts/
```

| File | What it tells you |
| --- | --- |
| `manifest.json` | The status of every planned trial |
| `config.json` | The resolved settings used for a trial |
| `events.jsonl` | A sequence of model, tool, memory, retry, and other events; one JSON object per line |
| `messages.json` | The recorded conversation at each scenario step |
| `final-state.json` | The outcome, model-call count, final memory, and any error |
| `workspace-manifest.json` | Which workspace files changed or were deleted |
| `artifacts/` | New or modified workspace files and, when applicable, writable memory state |

A trial can be `pending`, `running`, `completed`, `failed`, `interrupted`, or `limit_reached`. The command exits with a nonzero status if any trial does not complete. Authentication-like fields are redacted from recorded events and messages.

## Configure memory

Memory passes through four stages:

1. **Contents:** load the source files or JSON records.
2. **Retrieval:** select the records to use.
3. **Representation:** turn the selected records into text or files.
4. **Delivery:** make the result available to the agent.

Add a block like this to your baseline:

```yaml
memory:
  contents: ./memory/notes.md
  retrieval: {type: all}
  representation: {type: verbatim}
  delivery: {type: system-prompt, timing: once-per-user-input}
  mutability: read-only
```

Built-in retrieval uses `all` records. Built-in representations are `verbatim`, `markdown-records`, and `json-records`.

| Delivery type | How the agent receives memory |
| --- | --- |
| `system-prompt` | Added to the system prompt |
| `context-message` | A hidden user-role message before the current user input; requires `role: user` and `placement: before-user-input` |
| `tool` | Through an explicitly registered memory tool |
| `files` | As files in the trial's workspace |

Prompt and context-message delivery support `once-per-user-input` or `before-every-model-call` timing. Scenarios separately control whether conversation history is shared between steps and whether memory is carried forward or reset.

JSON memory files use this format:

```json
{
  "records": [
    {"id": "preference-1", "content": "Prefer primary sources.", "metadata": {"topic": "sources"}}
  ]
}
```

### Custom memory strategies

All delivery modes apply the configured retrieval and representation stages. Custom strategy modules can export:

- A retrieval function `(input, runContext)` returning `{records}`.
- A render function `(selection, runContext)` returning `{text, files?}`.
- An object with a `retrieve()` or `render()` method using those arguments.

For a factory, add `factory: true` to the custom strategy configuration. The factory receives its `config` and returns the strategy object. Strategies are instantiated once per trial, and a failed memory stage fails the trial.

Memory tools pass their query through retrieval and return rendered text. File delivery writes the renderer's `files` entries, or a single text file if `files` is omitted. It runs initially and after a memory reset. The initial retrieval receives the first scenario input. File destinations must stay inside the workspace; rendered paths must stay inside the memory directory. Paths cannot contain symlinks. Writable file changes are captured as file-content records.

## Configure tools

Choose how a condition exposes tools to its agent:

| Mode | Behavior |
| --- | --- |
| `pi-default` | Use Pi's default tools: `read`, `bash`, `edit`, and `write` |
| `replace` | Use only the entries you declare |
| `extend` | Start with the defaults, then add, remove, or replace tools |

Other available Pi built-ins are `powershell`, `grep`, `find`, and `ls`. Entries can use `source: pi-builtin`, `custom`, `fixture`, or `memory`.

For example, add a custom search tool:

```yaml
tools:
  mode: extend
  entries:
    - name: search
      source: custom
      module: ./tools/search.mjs
```

The module's default or named export is a factory called as `factory(runContext, config)`. It returns one Pi `ToolDefinition` or an array of definitions. Custom modules are trusted code and execute during a run.

Fixture tools return fixed JSON responses. To use memory through a tool, declare an entry with `source: memory` whose name matches `memory.delivery.name`.

## Reproducibility and limits

Every trial runs in a separate process and workspace. Experiment sessions disable discovery of personal extensions, ancestor/project instructions, skills, prompt templates, and global settings. Pi is pinned to `@earendil-works/pi-coding-agent@0.85.1`.

To freeze a plan before executing it:

```sh
trace check ./my-experiment --write-plan ./my-experiment.plan.json
trace run --plan ./my-experiment.plan.json
```

A saved plan freezes the trial order, resolved configuration, input file contents, and input directory membership. trace rejects it if those inputs, the Node version, runner version, Pi version, or dependency lock change. Regenerate plans created before plan format 2. Remote model aliases can still change; trace records the requested and provider-reported identifiers.

The published package includes `npm-shrinkwrap.json` to lock dependency versions. trace records its hash in each plan and execution bundle.

Default limits are **5 minutes** and **100 model calls** per trial. Set `limits.wall_clock_ms` and `limits.max_model_calls` in the baseline to change them. The model-call budget includes agent turns, retrieval helpers, and compaction.

Useful command options:

| Option | Purpose |
| --- | --- |
| `check --json` | Print validation results and the plan as JSON |
| `run --concurrency 2` | Run up to two trials at a time |
| `run --seed 1234` | Set the execution seed; cannot be combined with a saved plan |
| `run --output <directory>` | Choose an empty output directory |
| `trace --help` | Show command usage |

## Development

```sh
npm run check
npm test
npm run build
```

The required test suite runs offline with fixture models and tools. Live-provider tests are opt-in.

### Test the installable package

```sh
npm run test:package
```

This builds and packs the release archive, installs it in a temporary project, and checks the installed CLI, starter files, bundled example, saved-plan execution with concurrent workers, JavaScript API, and TypeScript declarations. It downloads dependencies from npm and runs four offline fixture trials. Temporary files are removed afterward.

### Release

The package is configured for public publication as `@nhagar/trace`. Sign in to npm as `nhagar`, run the checks, and publish from a clean checkout:

```sh
npm login
npm whoami
npm publish --access public
```

`prepublishOnly` runs type-checking, the offline test suite, and the installable-package check. `prepack` builds fresh JavaScript before packing. For later releases, choose a new version with `npm version patch`, `minor`, or `major` before publishing.
