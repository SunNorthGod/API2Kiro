import { CwEvent } from "./cwTypes";

export interface CapturedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const FALLBACK_CONTEXT_WINDOW = 500000;

/** Rough context window per model family; only used for the context-usage bar. */
function contextWindowForModel(modelId: string): number {
  const m = (modelId || "").toLowerCase();
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
