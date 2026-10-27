import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
  InMemoryCredentialStore,
  type FauxContentBlock,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { BaselineConfig, RetrievalInput, RunContext } from "../../types.js";
import { InterruptedError, LimitReachedError } from "../../errors.js";
import { redactSecrets } from "../../util/object.js";
import { buildToolRegistry, type ResolvedTools } from "../../components/tools.js";
import { MemoryStore, memoryEnvelope } from "../../components/memory.js";
import { injectSystemMemory } from "./payload.js";

interface FixtureResponse {
  text?: string;
  thinking?: string;
  tool_call?: { name: string; arguments?: Record<string, unknown>; id?: string };
  error?: string;
  stop_reason?: "stop" | "length" | "toolUse" | "error" | "aborted";
}

interface FixtureFile {
  responses: FixtureResponse[];
}

export interface AdapterSession {
  session: AgentSession;
  dispose: () => void;
}

export class PiAdapter {
  private runtime!: ModelRuntime;
  private model!: Model<string>;
  private faux: ReturnType<typeof fauxProvider> | undefined;
  private promptText: string | undefined;
  private modelCallsValue = 0;
  private currentStep?: string;
  private currentPerCallMemory: string | undefined;
  private currentOnceContextMemory: string | undefined;
  private currentSystemPrompt = "";
  private memory: MemoryStore | undefined;
  private tools: ResolvedTools | undefined;
  private initialized = false;
  private failure: Error | undefined;

  constructor(
    private readonly config: BaselineConfig,
    private readonly ctx: RunContext,
  ) {}

  get modelCalls(): number {
    return this.modelCallsValue;
  }

  get memoryStore(): MemoryStore | undefined {
    return this.memory;
  }

  setStep(stepId: string): void {
    this.currentStep = stepId;
  }

  throwIfFailed(): void {
    if (this.failure) throw this.failure;
    if (this.ctx.signal.aborted) throw new InterruptedError();
  }

  private rememberFailure(error: unknown): Error {
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    return this.failure;
  }

  async initialize(initialMemoryInput: RetrievalInput = { conversation: [] }): Promise<void> {
    this.throwIfFailed();
    if (this.initialized) return;
    const modelConfig = this.config.model!;
    this.runtime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
      ...(modelConfig.fixture ? { credentials: new InMemoryCredentialStore() } : {}),
    });
    // Extension hooks swallow thrown errors. Enforce failures and call budgets at
    // the runtime boundary shared by agent turns, retrieval helpers, and compaction.
    const streamSimple = this.runtime.streamSimple.bind(this.runtime);
    this.runtime.streamSimple = (model, context, options) => {
      this.throwIfFailed();
      const maxCalls = this.config.limits?.max_model_calls ?? 100;
      if (this.modelCallsValue >= maxCalls) {
        throw this.rememberFailure(new LimitReachedError("model_calls", `Maximum model calls (${maxCalls}) reached`));
      }
      this.modelCallsValue += 1;
      return streamSimple(model, context, {
        ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, this.ctx.signal]) : this.ctx.signal,
        onPayload: async (payload, requestedModel) => {
          const result = await options?.onPayload?.(payload, requestedModel);
          this.throwIfFailed();
          return result;
        },
      });
    };
    if (modelConfig.fixture) {
      const file = JSON.parse(await readFile(modelConfig.fixture.responses, "utf8")) as FixtureFile;
      this.faux = fauxProvider({
        provider: modelConfig.provider,
        models: [{
          id: modelConfig.id,
          reasoning: modelConfig.capabilities?.reasoning ?? false,
          input: ["text"],
          contextWindow: modelConfig.fixture.context_window ?? 128_000,
          maxTokens: modelConfig.settings?.max_tokens ?? 16_384,
        }],
        ...(modelConfig.fixture.tokens_per_second ? { tokensPerSecond: modelConfig.fixture.tokens_per_second } : {}),
      });
      this.faux.setResponses(file.responses.map((response) => {
        const blocks: FauxContentBlock[] = [];
        if (response.thinking) blocks.push(fauxThinking(response.thinking));
        if (response.text) blocks.push(fauxText(response.text));
        if (response.tool_call) {
          blocks.push(fauxToolCall(response.tool_call.name, response.tool_call.arguments ?? {}, response.tool_call.id ? { id: response.tool_call.id } : undefined));
        }
        return fauxAssistantMessage(blocks, {
          stopReason: response.error ? "error" : response.stop_reason ?? (response.tool_call ? "toolUse" : "stop"),
          ...(response.error ? { errorMessage: response.error } : {}),
        });
      }));
      this.runtime.registerNativeProvider(this.faux.provider);
      this.model = this.faux.getModel(modelConfig.id)!;
    } else {
      const model = this.runtime.getModel(modelConfig.provider, modelConfig.id);
      if (!model) throw new Error(`Unknown model ${modelConfig.provider}/${modelConfig.id}; no fallback was attempted`);
      const auth = await this.runtime.getAuth(model, { env: process.env as Record<string, string> });
      if (!auth) throw new Error(`No credentials available for ${modelConfig.provider}/${modelConfig.id}`);
      this.model = model as Model<string>;
    }

    this.model = {
      ...this.model,
      ...(modelConfig.settings?.max_tokens ? { maxTokens: modelConfig.settings.max_tokens } : {}),
      samplingParams: {
        ...(this.model.samplingParams ?? {}),
        ...(modelConfig.settings?.temperature !== undefined ? { temperature: modelConfig.settings.temperature } : {}),
        ...(modelConfig.settings?.top_p !== undefined ? { top_p: modelConfig.settings.top_p } : {}),
      },
    };
    this.ctx.recorded_client.complete = async (request) => {
      this.throwIfFailed();
      const requestId = randomUUID();
      const requestedModel = request.provider || request.model
        ? this.runtime.getModel(request.provider ?? this.model.provider, request.model ?? this.model.id)
        : this.model;
      if (!requestedModel) throw new Error(`Recorded client model not found: ${request.provider}/${request.model}`);
      await this.ctx.record("memory_model_request", { request_id: requestId, request });
      const response = await this.runtime.completeSimple(
        requestedModel,
        {
          systemPrompt: request.system_prompt ?? "You are a retrieval helper.",
          messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
          tools: [],
        },
        {
          signal: this.ctx.signal,
          ...(request.thinking && request.thinking !== "off" ? { reasoning: request.thinking } : {}),
        },
      );
      await this.ctx.record("memory_model_response", { request_id: requestId, response: redactSecrets(response) });
      return response;
    };
    this.throwIfFailed();
    if (this.config.system_prompt.file) this.promptText = await readFile(this.config.system_prompt.file, "utf8");
    else this.promptText = this.config.system_prompt.text;
    if (this.config.memory) {
      this.memory = new MemoryStore(this.config.memory, this.ctx, (error) => { this.rememberFailure(error); });
      await this.memory.initialize();
      await this.memory.materializeFiles(initialMemoryInput);
    }
    this.throwIfFailed();
    this.tools = await buildToolRegistry(this.config, this.ctx, this.memory);
    this.throwIfFailed();
    await this.ctx.record("tool_registry", {
      definitions: this.tools.definitions,
      allowlist: this.tools.allowlist ?? ["read", "bash", "edit", "write"],
    });
    this.initialized = true;
  }

  private instrumentation(): InlineExtension {
    return {
      name: "agent-study-recorder",
      hidden: true,
      factory: (pi) => {
        pi.on("before_agent_start", async (event) => {
          this.currentSystemPrompt = this.config.system_prompt.mode === "replace"
            ? this.promptText ?? ""
            : event.systemPrompt;
          await this.ctx.record("system_prompt", {
            pi_generated: event.systemPrompt,
            transformation: this.config.system_prompt,
            configured_effective: this.currentSystemPrompt,
            system_prompt_options: redactSecrets(event.systemPromptOptions),
          });
          const delivery = this.config.memory?.delivery;
          const replacement = this.config.system_prompt.mode === "replace"
            ? { systemPrompt: this.currentSystemPrompt }
            : undefined;
          if (!this.memory || !delivery || delivery.type === "tool" || delivery.type === "files" || delivery.timing === "before-every-model-call") return replacement;
          const rendered = await this.memory.retrieve({ conversation: [], query: event.prompt, ...(this.currentStep ? { step_id: this.currentStep } : {}) });
          const content = memoryEnvelope(rendered);
          await this.ctx.record("memory_injected", { delivery: delivery.type, timing: "once-per-user-input", content });
          if (delivery.type === "system-prompt") {
            this.currentSystemPrompt = `${this.currentSystemPrompt}\n\n---\n\n${content}`;
            return { systemPrompt: this.currentSystemPrompt };
          }
          this.currentOnceContextMemory = content;
          return replacement;
        });
        pi.on("context", async (event) => {
          this.throwIfFailed();
          let messages = event.messages;
          const delivery = this.config.memory?.delivery;
          if (delivery?.type === "context-message" && delivery.timing !== "before-every-model-call" && this.currentOnceContextMemory) {
            const memoryMessage = {
              role: "custom",
              customType: "agent-study-memory",
              content: this.currentOnceContextMemory,
              display: false,
              details: { role: delivery.role },
              timestamp: Date.now(),
            } as never;
            let latestUser = -1;
            for (let index = messages.length - 1; index >= 0; index -= 1) {
              if (messages[index]?.role === "user") {
                latestUser = index;
                break;
              }
            }
            messages = [...messages];
            messages.splice(latestUser < 0 ? messages.length : latestUser, 0, memoryMessage);
          }
          if (this.memory && delivery && "timing" in delivery && delivery.timing === "before-every-model-call") {
            const rendered = await this.memory.retrieve({ conversation: event.messages, ...(this.currentStep ? { step_id: this.currentStep } : {}) });
            const content = memoryEnvelope(rendered);
            await this.ctx.record("memory_injected", { delivery: delivery.type, timing: delivery.timing, content });
            if (delivery.type === "context-message") {
              const memoryMessage = {
                role: "custom",
                customType: "agent-study-memory",
                content,
                display: false,
                details: { role: delivery.role },
                timestamp: Date.now(),
              } as never;
              let latestUser = -1;
              for (let index = event.messages.length - 1; index >= 0; index -= 1) {
                if (event.messages[index]?.role === "user") {
                  latestUser = index;
                  break;
                }
              }
              messages = [...event.messages];
              messages.splice(latestUser < 0 ? messages.length : latestUser, 0, memoryMessage);
            } else if (delivery.type === "system-prompt") this.currentPerCallMemory = content;
          }
          const effectiveSystemPrompt = this.currentPerCallMemory
            ? `${this.currentSystemPrompt}\n\n---\n\n${this.currentPerCallMemory}`
            : this.currentSystemPrompt;
          await this.ctx.record("effective_model_request", {
            model_call: this.modelCallsValue + 1,
            system_prompt: effectiveSystemPrompt,
            messages: redactSecrets(messages),
            serialized_provider_payload_available: !this.config.model?.fixture,
          });
          return { messages };
        });
        pi.on("before_provider_request", async (event) => {
          const payload = this.currentPerCallMemory
            ? injectSystemMemory(event.payload, this.currentPerCallMemory)
            : event.payload;
          await this.ctx.record("provider_payload", { model_call: this.modelCallsValue, payload: redactSecrets(payload) });
          this.currentPerCallMemory = undefined;
          return payload;
        });
        pi.on("after_provider_response", async (event) => {
          await this.ctx.record("provider_response", { status: event.status, headers: redactSecrets(event.headers) });
        });
      },
    };
  }

  async createSession(): Promise<AdapterSession> {
    await this.initialize();
    const isolatedAgentDir = path.join(this.ctx.workspace, ".agent-study", "pi-agent");
    await mkdir(isolatedAgentDir, { recursive: true });
    const settings = SettingsManager.inMemory({
      compaction: {
        enabled: this.config.session.compaction.enabled,
        ...(this.config.session.compaction.reserve_tokens !== undefined ? { reserveTokens: this.config.session.compaction.reserve_tokens } : {}),
        ...(this.config.session.compaction.keep_recent_tokens !== undefined ? { keepRecentTokens: this.config.session.compaction.keep_recent_tokens } : {}),
      },
      retry: {
        enabled: this.config.session.retries.enabled,
        maxRetries: this.config.session.retries.max_retries,
        ...(this.config.session.retries.base_delay_ms !== undefined ? { baseDelayMs: this.config.session.retries.base_delay_ms } : {}),
        ...(this.config.session.retries.provider ? {
          provider: {
            ...(this.config.session.retries.provider.timeout_ms !== undefined ? { timeoutMs: this.config.session.retries.provider.timeout_ms } : {}),
            ...(this.config.session.retries.provider.max_retries !== undefined ? { maxRetries: this.config.session.retries.provider.max_retries } : {}),
            ...(this.config.session.retries.provider.max_retry_delay_ms !== undefined ? { maxRetryDelayMs: this.config.session.retries.provider.max_retry_delay_ms } : {}),
          },
        } : {}),
      },
    });
    const tools = this.tools!;
    const loader = new DefaultResourceLoader({
      cwd: this.ctx.workspace,
      agentDir: isolatedAgentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [this.instrumentation()],
      ...(this.config.system_prompt.mode === "replace" ? { systemPrompt: this.promptText ?? "" } : {}),
      ...(this.config.system_prompt.mode === "append" ? { appendSystemPrompt: [this.promptText ?? ""] } : {}),
    });
    await loader.reload();
    const result = await createAgentSession({
      cwd: this.ctx.workspace,
      agentDir: isolatedAgentDir,
      modelRuntime: this.runtime,
      model: this.model,
      thinkingLevel: this.config.model?.thinking ?? "off",
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(this.ctx.workspace),
      settingsManager: settings,
      ...(tools.allowlist ? { tools: tools.allowlist } : {}),
      customTools: tools.customTools,
    });
    if (this.ctx.signal.aborted) {
      result.session.dispose();
      this.throwIfFailed();
    }
    if (result.extensionsResult.errors.length > 0) throw new Error(`Internal adapter extension failed: ${JSON.stringify(result.extensionsResult.errors)}`);
    await this.ctx.record("session_created", {
      requested_model: { provider: this.config.model!.provider, id: this.config.model!.id },
      provider_reported_model: { provider: result.session.model?.provider, id: result.session.model?.id },
      ambient_resources: {
        extensions: result.extensionsResult.extensions.filter((extension) => !extension.path.includes("agent-study-recorder")).map((extension) => extension.path),
        skills: loader.getSkills().skills.map((skill) => skill.filePath),
        context_files: loader.getAgentsFiles().agentsFiles.map((file) => file.path),
        prompts: loader.getPrompts().prompts.map((prompt) => prompt.name),
      },
    });
    const unsubscribe = result.session.subscribe((event) => {
      void this.ctx.record(event.type, { event: redactSecrets(event) });
    });
    return {
      session: result.session,
      dispose: () => {
        unsubscribe();
        result.session.dispose();
      },
    };
  }

  dispose(): void {
    this.faux = undefined;
  }
}
