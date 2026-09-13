# agent-study

`agent-study` is a TypeScript experiment runner around the pinned [Pi coding-agent SDK](https://github.com/earendil-works/pi/tree/main/packages/coding-agent). It expands controlled conditions and scenarios into isolated Pi sessions and records model requests, messages, tool activity, memory operations, and workspace changes for later analysis.

The runner is for behavioral experiments, not benchmark scoring. A run does not need a known correct answer or scalar metric.

## Requirements

- Node.js 22.19 or newer
- Credentials for any live provider you configure (fixture models need none)

Pi is pinned exactly to `@earendil-works/pi-coding-agent@0.85.1`. Personal extensions, project/ancestor instructions, skills, templates, and global settings are not discovered by experiment sessions. Authentication remains external to experiment bundles.

## Install and build

```sh
npm install
npm run build
npm link
```

## Quick start

```sh
agent-study init ./my-experiment
# Edit my-experiment/baseline.yaml and choose an explicit provider/model.
agent-study check ./my-experiment
agent-study check ./my-experiment --json --write-plan ./my-experiment.plan.json
agent-study run ./my-experiment --output ./results
agent-study run --plan ./my-experiment.plan.json
```

`init` writes an editable experiment layout but never installs packages or calls a model. It refuses to overwrite any generated file.

`check` performs only local parsing, reference resolution, compatibility checks, condition expansion, hashing, and run planning. It never imports custom experiment modules, executes tools, performs retrieval, or makes network/model requests. Static validation cannot prove that credentials, remote models, or trusted custom implementations will work.

`run` repeats the same static checks (or validates a frozen saved plan), imports custom modules in per-run worker processes, resolves credentials, and executes trials. A saved plan is rejected if its content, referenced assets, Node version, runner version, Pi version, or dependency lock changes.

## Configuration

An experiment combines a complete baseline, either explicit conditions or a Cartesian matrix, scenarios, and repetitions:

```yaml
schema_version: 1
id: memory-source-selection
base: ./baseline.yaml
matrix:
  axes:
    model:
      - id: a
        value: {from: ./models/a.yaml}
      - id: b
        value: {from: ./models/b.yaml}
    memory.contents:
      - id: neutral
        value: ./memory/neutral.md
      - id: academic
        value: ./memory/academic.md
      - id: news
        value: ./memory/news.md
scenarios:
  - ./scenarios/quick-answer.yaml
  - ./scenarios/follow-up.yaml
repetitions: 10
execution:
  concurrency: 1
  order: randomized
  seed: 1234
  failure_policy: continue
```

That design produces 120 unique runs. Arrays/scalars replace inherited values; objects deep-merge. Matrix axes cannot overlap. Explicit conditions are available for nonfactorial designs.

### Tools

Tool registry modes are `pi-default`, `replace`, and `extend`. Pi built-ins are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. Custom factories are trusted code and receive a per-run context:

```yaml
tools:
  mode: extend
  entries:
    - name: search
      source: custom
      module: ./tools/search.ts
```

A factory's default (or named) export is called as `factory(runContext, config)` and returns one Pi `ToolDefinition` or an array. Fixture tools read deterministic JSON. Memory tool delivery must be explicitly declared with `source: memory`; the validator never silently adds it.

### Memory

Memory is configured as independent contents → retrieval → representation → delivery stages. Built-in retrieval is `all`; renderers are `verbatim`, `markdown-records`, and `json-records`. Custom strategies export a function or an object implementing `retrieve()`/`render()`. Delivery supports system-prompt injection, hidden context messages, explicit tools, or workspace files. Memory is read-only unless set to `writable`.

JSON record files use this schema:

```json
{
  "records": [
    {"id": "preference-1", "content": "Prefer primary sources.", "metadata": {"topic": "sources"}}
  ]
}
```

### Fixture models

Offline experiments can use Pi's own faux provider while retaining the normal Pi session and tool loop:

```yaml
provider: fixture
id: scripted
thinking: off
fixture:
  responses: ./responses.json
capabilities:
  reasoning: false
  settings: [max_tokens]
```

Responses may contain `text`, `thinking`, `tool_call`, `error`, and `stop_reason`. See [`examples/memory-comparison`](./examples/memory-comparison) for the end-to-end release-gate experiment.

## Results

Each execution produces:

```text
results/<execution-id>/
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

Run statuses are `pending`, `running`, `completed`, `failed`, `interrupted`, and `limit_reached`. Events have monotonic per-run sequence numbers. Authentication-like fields are redacted. File manifests record initial/final inventories, and changed contents are preserved as artifacts. A batch exits nonzero if any planned run is incomplete.

## Development

```sh
npm run check
npm test
npm run build
```

Live-provider tests are intentionally opt-in; the required suite uses fixture providers and tools.
