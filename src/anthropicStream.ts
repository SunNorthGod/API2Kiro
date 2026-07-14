import { CwEvent } from "./cwTypes";
import { contextWindowForModel as relayContextWindow } from "./modelStore";

export interface CapturedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const FALLBACK_CONTEXT_WINDOW = 200000;

/**
 * Context window for the context-usage bar. Prefers the relay's /models
 * `context_window` (authoritative and identical to the model list Kiro's picker
 * shows, so one source of truth drives both). Falls back to a name heuristic
 * aligned to Kiro's official ListAvailableModels, then 200K.
 */
function contextWindowForModel(modelId: string): number {
  const fromRelay = relayContextWindow(modelId);
  if (fromRelay && fromRelay > 0) {
    return fromRelay;
  }
  const m = (modelId || "").toLowerCase();
  // 1M 上下文（对齐 Kiro 官方 ListAvailableModels）：auto、Opus 4.8/4.7/4.6、Sonnet 4.6/5、Fable 5
  if (
    m === "auto" ||
    m.includes("opus-4-8") || m.includes("opus-4.8") ||
    m.includes("opus-4-7") || m.includes("opus-4.7") ||
    m.includes("opus-4-6") || m.includes("opus-4.6") ||
    m.includes("sonnet-4-6") || m.includes("sonnet-4.6") ||
    m.includes("sonnet-5") ||
    m.includes("fable-5") || m.includes("fable5")
  ) {
    return 1000000;
  }
  // GPT 5.6 系列（sol/terra/luna）输入窗口 272K（对齐 Kiro 官方 ListAvailableModels）
  if (m.includes("gpt")) {
    return 272000;
  }
  // 其余 Claude（Opus 4.5、Sonnet 4.5/4、Haiku 等）为 200K
  if (m.includes("opus") || m.includes("sonnet") || m.includes("haiku") || m.includes("claude")) {
    return 200000;
  }
  return FALLBACK_CONTEXT_WINDOW;
}

function contextUsagePercentFloat(tokens: number, modelId: string): number | null {
  if (!tokens || tokens <= 0) {
    return null;
  }
  const window = contextWindowForModel(modelId);
  if (!window || window <= 0) {
    return null;
  }
  return Math.max(0, Math.min(100, (tokens / window) * 100));
}

interface AnthropicSseEvent {
  type: string;
  message?: { usage?: Record<string, number> };
  content_block?: { type?: string; id?: string; name?: string; data?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
  };
  usage?: Record<string, number>;
}

/**
 * Converts an Anthropic Messages streaming SSE into Kiro's CodeWhisperer event
 * objects. Ported from the reference `AnthropicStreamConverter`, with usage
 * capture exposed for local cache-hit-rate statistics.
 */
export class AnthropicStreamConverter {
  private conversationId: string;
  private modelId: string;

  private currentToolId = "";
  private currentToolName = "";
  private currentToolInput = "";
  private inToolUse = false;

  private inThinking = false;
  private curThinkingText = "";
  private curSignature = "";

  private startInputTokens = 0;
  private pendingContextPct: number | null = null;

  /** Latest usage seen for this response (updated on message_start/message_delta). */
  public usage: CapturedUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  constructor(conversationId: string, modelId: string) {
    this.conversationId = conversationId;
    this.modelId = modelId;
  }

  /** Process one raw SSE line ("data: {...}"). Returns 0+ CwEvents. */
  processLine(line: string): CwEvent[] {
    if (!line.startsWith("data:")) {
      return [];
    }
    const payload = line.slice(line.indexOf(":") + 1).trim();
    if (!payload || payload === "[DONE]") {
      return [];
    }
    try {
      return this.handleEvent(JSON.parse(payload));
    } catch {
      return [];
    }
  }

  private handleEvent(ev: AnthropicSseEvent): CwEvent[] {
    const out: CwEvent[] = [];

    if (ev.type === "message_start") {
      out.push({ messageMetadataEvent: { conversationId: this.conversationId } });
      const u = ev.message?.usage;
      if (u) {
        this.captureUsage(u);
        const total =
          (u.input_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0);
        this.startInputTokens = total;
        this.pendingContextPct = contextUsagePercentFloat(total, this.modelId);
      }
      return out;
    }

    if (ev.type === "content_block_start") {
      const block = ev.content_block;
      if (block?.type === "tool_use") {
        this.inToolUse = true;
        this.currentToolId = block.id || "";
        this.currentToolName = block.name || "";
        this.currentToolInput = "";
      } else if (block?.type === "thinking") {
        this.inThinking = true;
        this.curThinkingText = "";
        this.curSignature = "";
      }
      return out;
    }

    if (ev.type === "content_block_delta") {
      const d = ev.delta;
      if (d?.type === "text_delta" && d.text) {
        out.push({
          assistantResponseEvent: { content: d.text, modelId: this.modelId },
        });
      } else if (d?.type === "thinking_delta" && d.thinking) {
        this.curThinkingText += d.thinking;
        out.push({ reasoningContentEvent: { text: d.thinking } });
      } else if (d?.type === "signature_delta" && d.signature) {
        this.curSignature += d.signature;
      } else if (d?.type === "input_json_delta" && d.partial_json) {
        this.currentToolInput += d.partial_json;
      }
      return out;
    }

    if (ev.type === "content_block_stop") {
      if (this.inThinking) {
        if (this.curSignature) {
          out.push({ reasoningContentEvent: { signature: this.curSignature } });
        }
        this.inThinking = false;
        this.curThinkingText = "";
        this.curSignature = "";
      }
      if (this.inToolUse) {
        out.push({
          toolUseEvent: {
            toolUseId: this.currentToolId,
            name: this.currentToolName,
            input: this.currentToolInput || "{}",
          },
        });
        this.inToolUse = false;
        this.currentToolId = "";
        this.currentToolName = "";
        this.currentToolInput = "";
      }
      return out;
    }

    if (ev.type === "message_delta" && ev.usage) {
      this.captureUsage(ev.usage);
      // 优先采用中转站透传的「后端真实上下文占用率」(contextUsagePercentage)，而非本地
      // token/窗口 估算。原生 Kiro 直连 AWS 时读的就是后端这个值；我们透传同一个值，上下文条
      // 与 Kiro 的摘要触发点就与原生逐字节对齐，无需我们复刻后端的上下文核算。
      // 实测(2026-07 直连后端对拍)：后端占用率随 token 线性增长、每个模型分母不同，且都比
      // 我们 /models 上报的窗口更大——opus-4-8 有效分母 ≈1.47M(报 1M)、sonnet-4.5 ≈454K
      // (报 200K)。因此本地按上报窗口自算会与后端不一致(opus 会“高报”约 1.47 倍)，透传后端
      // 真值可消除该偏差。
      const relayPct = (ev.usage as Record<string, number>).contextUsagePercentage;
      if (typeof relayPct === "number" && relayPct >= 0) {
        this.pendingContextPct = Math.max(0, Math.min(100, relayPct));
      }
      const inTokens =
        (ev.usage.input_tokens || 0) +
        (ev.usage.cache_read_input_tokens || 0) +
        (ev.usage.cache_creation_input_tokens || 0);
      out.push({
        metadataEvent: {
          type: "token_usage",
          inputTokens: inTokens || this.startInputTokens,
          outputTokens: ev.usage.output_tokens || 0,
        },
      });
    }

    return out;
  }

  private captureUsage(u: Record<string, number>): void {
    if (typeof u.input_tokens === "number") {
      this.usage.inputTokens = u.input_tokens;
    }
    if (typeof u.output_tokens === "number") {
      this.usage.outputTokens = u.output_tokens;
    }
    if (typeof u.cache_read_input_tokens === "number") {
      this.usage.cacheReadTokens = u.cache_read_input_tokens;
    }
    if (typeof u.cache_creation_input_tokens === "number") {
      this.usage.cacheCreationTokens = u.cache_creation_input_tokens;
    }
  }

  /** Emit any trailing events (unterminated tool call, context usage bar). */
  flush(): CwEvent[] {
    const out: CwEvent[] = [];
    if (this.inToolUse) {
      out.push({
        toolUseEvent: {
          toolUseId: this.currentToolId,
          name: this.currentToolName,
          input: this.currentToolInput || "{}",
        },
      });
      this.inToolUse = false;
    }
    if (this.pendingContextPct !== null) {
      out.push({ contextUsageEvent: { contextUsagePercentage: this.pendingContextPct } });
      this.pendingContextPct = null;
    }
    return out;
  }
}
