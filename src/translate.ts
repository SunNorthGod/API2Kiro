import {
  AnthropicJsonSchema,
  CwRequest,
  CwToolSpec,
  CwUserInputMessage,
} from "./cwTypes";
import {
  getDefaultModel,
  getMaxTokens,
  getModelMapping,
  getThinkingConfig,
  getThinkingBudget,
  ThinkingConfig,
} from "./config";
import { hasEffortVariant, thinkingVariantOf, EffortLevel } from "./modelStore";
import { budgetForEffort, getEffortMode } from "./effort";

const DEFAULT_MODEL_ID = "CLAUDE_SONNET_4_20250514_V1_0";

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: AnthropicJsonSchema;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  stream: boolean;
  tools?: AnthropicTool[];
  thinking?: ThinkingConfig;
  /** Reasoning-effort level (low/medium/high/xhigh/max). The relay maps this to
   *  the CodeWhisperer output_config.effort + <thinking_effort> so the user's
   *  chosen tier (e.g. max) actually reaches the backend instead of defaulting. */
  output_config?: { effort: string };
}

/** Find the most recent modelId Kiro attached to any user message. */
export function latestModelId(req: CwRequest): string {
  const items = [
    ...(req.conversationState.history || []),
    ...(req.conversationState.currentMessage ? [req.conversationState.currentMessage] : []),
  ];
  for (let i = items.length - 1; i >= 0; i--) {
    const id = items[i].userInputMessage?.modelId;
    if (id) {
      return id;
    }
  }
  return DEFAULT_MODEL_ID;
}

export function conversationId(req: CwRequest): string {
  return req.conversationState.conversationId || "unknown";
}

/** Map a Kiro internal model ID to the upstream model ID. */
export function resolveModel(kiroModelId: string): string {
  const mapping = getModelMapping();
  if (mapping[kiroModelId]) {
    return mapping[kiroModelId];
  }
  const def = getDefaultModel();
  if (def) {
    return def;
  }
  return kiroModelId;
}

function parseToolSpec(spec: CwToolSpec): {
  name: string;
  description?: string;
  schema?: AnthropicJsonSchema;
} {
  const ts = spec.toolSpecification || spec;
  const name = ts.name || "";
  const description = ts.description;
  let schema: AnthropicJsonSchema | undefined;
  const rawSchema = (ts as { inputSchema?: unknown }).inputSchema;
  if (rawSchema && typeof rawSchema === "object") {
    const asJson = (rawSchema as { json?: AnthropicJsonSchema }).json;
    schema = asJson && typeof asJson === "object" ? asJson : (rawSchema as AnthropicJsonSchema);
  }
  return { name, description, schema };
}

/** Serialize a tool result payload (which may be structured) to plain text. */
function toolResultToText(content: unknown): string {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item == null) {
        continue;
      }
      if (typeof item === "string") {
        parts.push(item);
      } else if (typeof item === "object") {
        const obj = item as Record<string, unknown>;
        if (typeof obj.text === "string") {
          parts.push(obj.text);
        } else if (obj.json !== undefined) {
          parts.push(typeof obj.json === "string" ? obj.json : JSON.stringify(obj.json));
        } else {
          parts.push(JSON.stringify(obj));
        }
      } else {
        parts.push(String(item));
      }
    }
    return parts.join("\n");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") {
      return obj.text;
    }
    return JSON.stringify(obj);
  }
  return String(content);
}

/** Parse a tool_use input that may arrive as a JSON string or already-parsed object. */
function parseToolInput(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      return JSON.parse(input);
    } catch {
      return {};
    }
  }
  return input ?? {};
}

/** Concatenate editor/context blocks Kiro attaches into a single text block. */
function buildContextText(msg: CwUserInputMessage): string {
  const parts: string[] = [];
  const ctx = msg.userInputMessageContext;
  for (const c of ctx?.additionalContext || []) {
    const inner = (c.innerContext || "").trim();
    if (!inner) {
      continue;
    }
    const label = [c.name, c.description].filter(Boolean).join(" - ");
    parts.push(`[Context${label ? ": " + label : ""}]\n${inner}`);
  }
  const editor = ctx?.editorState;
  if (editor?.document?.text) {
    parts.push(`[Active file: ${editor.document.relativeFilePath || ""}]\n${editor.document.text}`);
  }
  for (const d of editor?.relevantDocuments || []) {
    if (d?.text) {
      parts.push(`[File: ${d.relativeFilePath || ""}]\n${d.text}`);
    }
  }
  return parts.join("\n\n");
}

function buildUserText(msg: CwUserInputMessage): string {
  const ctxText = buildContextText(msg);
  const content = msg.content || "";
  if (ctxText) {
    return content ? content + "\n\n" + ctxText : ctxText;
  }
  return content;
}

/**
 * Build an Anthropic /v1/messages request body from Kiro's CodeWhisperer
 * request. Ports the reference plugin's `buildAnthropicRequest`.
 */
export function buildAnthropicRequest(req: CwRequest): AnthropicRequest {
  const state = req.conversationState;
  const items = [...(state.history || [])];
  if (state.currentMessage) {
    items.push(state.currentMessage);
  }

  const messages: AnthropicMessage[] = [];
  let tools: AnthropicTool[] | undefined;

  for (const item of items) {
    if (item.userInputMessage) {
      const uim = item.userInputMessage;
      const blocks: AnthropicContentBlock[] = [];

      for (const tr of uim.userInputMessageContext?.toolResults || []) {
        blocks.push({
          type: "tool_result",
          tool_use_id: tr.toolUseId,
          content: toolResultToText(tr.content),
        });
      }

      const text = buildUserText(uim);
      if (text) {
        blocks.push({ type: "text", text });
      }

      for (const img of uim.images || []) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: "image/" + img.format.toLowerCase(),
            data: img.source.bytes,
          },
        });
      }

      if (blocks.length > 0) {
        messages.push({
          role: "user",
          content:
            blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks,
        });
      }

      if (uim.userInputMessageContext?.tools) {
        tools = uim.userInputMessageContext.tools.map((spec) => {
          const { name, description, schema } = parseToolSpec(spec);
          const input_schema: AnthropicJsonSchema = {
            type: "object",
            properties: schema?.properties ?? {},
          };
          if (schema?.required) {
            input_schema.required = schema.required;
          }
          return { name, description, input_schema };
        });
      }
    }

    if (item.assistantResponseMessage) {
      const arm = item.assistantResponseMessage;
      const blocks: AnthropicContentBlock[] = [];
      if (arm.content) {
        blocks.push({ type: "text", text: arm.content });
      }
      for (const tu of arm.toolUses || []) {
        blocks.push({
          type: "tool_use",
          id: tu.toolUseId,
          name: tu.name,
          input: parseToolInput(tu.input),
        });
      }
      if (blocks.length === 0) {
        blocks.push({ type: "text", text: "(no content)" });
      }
      messages.push({
        role: "assistant",
        content:
          blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks,
      });
    }
  }

  const model = resolveModel(latestModelId(req));
  const maxTokens = getMaxTokens();

  const looksThinking = /thinking/i.test(model);
  let thinking = getThinkingConfig();
  if (looksThinking && thinking?.type !== "disabled") {
    thinking = { type: "enabled", budget_tokens: getThinkingBudget() };
  }

  const body: AnthropicRequest = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: true,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }
  if (thinking && thinking.type === "enabled" && thinking.budget_tokens) {
    setThinkingBudget(body, thinking.budget_tokens);
  }
  return body;
}

/**
 * Enable extended thinking with a budget that always satisfies Anthropic's
 * constraints: 1024 <= budget_tokens < max_tokens. We clamp the budget under
 * max_tokens instead of raising max_tokens, because many relays cap a model's
 * output tokens and would reject an inflated max_tokens. If the window is too
 * small to fit a valid budget, thinking is left off.
 */
export function setThinkingBudget(body: AnthropicRequest, budget: number): void {
  if (!budget || budget <= 0) {
    return;
  }
  const ceiling = body.max_tokens - 4096;
  const b = Math.min(budget, ceiling);
  if (b >= 1024) {
    body.thinking = { type: "enabled", budget_tokens: b };
  }
}

/**
 * Apply Kiro's selected effort level (max/xhigh/high/medium/low) to the request.
 *
 * - modelVariant / auto: if the relay exposes a `<model>-<effort>` variant, call
 *   that variant (this is how the reference plugin does it).
 * - thinkingBudget / auto: otherwise map the effort to an Anthropic extended
 *   thinking budget so the level still changes reasoning depth on any relay.
 *
 * Mutates `body` in place. `effort` is the resolved level (or undefined).
 */
export function applyEffort(body: AnthropicRequest, effort: EffortLevel | undefined): void {
  if (!effort) {
    return;
  }
  const mode = getEffortMode();
  if (mode === "off") {
    return;
  }

  // Always convey the effort LEVEL to the relay (it maps this to the CW
  // output_config.effort + <thinking_effort> tag). Without this the relay
  // defaults to "high", silently downgrading the user's chosen tier (e.g. max),
  // which is why extended "think a step, act a step" was weaker than native Kiro.
  body.output_config = { effort };

  const base = body.model;

  if (mode === "auto" || mode === "modelVariant") {
    // 1) Per-level variant, e.g. <model>-high (some relays expose these).
    if (hasEffortVariant(base, effort)) {
      body.model = `${base}-${effort}`;
      return;
    }
    // 2) modelVariant mode: fall back to the relay's dedicated -thinking model
    //    (this relay's reasoning switch), scaling the budget by effort.
    if (mode === "modelVariant") {
      const tv = thinkingVariantOf(base);
      if (tv) {
        body.model = tv;
        setThinkingBudget(body, budgetForEffort(effort));
      }
      // Variant-only mode: if nothing matches, leave the request unchanged.
      return;
    }
  }

  // auto (no variant found) or thinkingBudget: map effort to a thinking budget
  // on the same model. Harmless if the relay ignores it.
  setThinkingBudget(body, budgetForEffort(effort));
}
