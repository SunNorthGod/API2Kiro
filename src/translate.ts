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
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

/** 从 Kiro 历史 assistant 消息里提取带签名的 thinking 块（无签名则返回 null）。 */
function extractThinkingBlock(
  arm: import("./cwTypes").CwAssistantResponseMessage
): { type: "thinking"; thinking: string; signature: string } | null {
  const rc = arm.reasoningContent;
  let text: string | undefined;
  let signature: string | undefined;
  if (rc && typeof rc === "object") {
    text = rc.reasoningText?.text;
    signature = rc.reasoningText?.signature ?? arm.reasoningSignature;
  } else if (typeof rc === "string") {
    text = rc;
    signature = arm.reasoningSignature;
  }
  // Anthropic 硬要求 thinking 块带签名，否则后端 400。无签名则不回传。
  if (text && signature && text.length > 0 && signature.length > 0) {
    return { type: "thinking", thinking: text, signature };
  }
  return null;
}

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
      // 关键修复：把 Kiro 历史里带签名的推理块转成 Anthropic thinking 块，放在最前面。
      // 这是"直连能思考、插件不思考"的根因——Kiro 直连 AWS 时历史每轮都带 reasoningContent，
      // 让模型在工具循环中延续思考；而此前 buildAnthropicRequest 只读 content+toolUses，
      // 把它丢了，导致后端在工具轮停止思考。thinking 块必须排在 text/tool_use 之前。
      const thinkingBlock = extractThinkingBlock(arm);
      if (thinkingBlock) {
        blocks.push(thinkingBlock);
      }
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
 * 与 Kiro 官方对齐的核心：Kiro 原生**只**发 `additionalModelRequestFields =
 * { output_config: { effort } }`（见 Kiro 客户端 We7()），既不发 `thinking`
 * 也不发 budget_tokens，思考深度完全交给模型按 effort 自适应。因此默认（auto）
 * 模式就**原样透传** `output_config.effort`，不再自造 `thinking:adaptive`/budget
 * ——那套"模拟"是此前思考行为与官方对不齐、反复修不好的根因。
 *
 * 另外两种模式仅为兼容"不认 output_config.effort 的通用中转站"而保留，需用户显式开启：
 * - `modelVariant`：改调中转站暴露的 `<model>-<effort>` 或 `-thinking` 变体模型。
 * - `thinkingBudget`：把 effort 换算成 Anthropic 标准 `thinking.budget_tokens`。
 *
 * Mutates `body` in place. `effort` is the resolved level (or undefined).
 */
export function applyEffort(body: AnthropicRequest, effort: EffortLevel | undefined): void {
  if (!effort) {
    // Kiro 未给 effort（auto 档 / 老版本）→ 不加任何字段，让模型走默认，
    // 与 Kiro 原生 We7() 返回 undefined 的行为一致。
    return;
  }
  const mode = getEffortMode();
  if (mode === "off") {
    return;
  }

  // 透传 Kiro 原生 effort：中转站原样转发给 Kiro 后端的 output_config.effort。
  body.output_config = { effort };

  // 变体模式（可选）：部分中转站用独立的 <model>-<effort> / -thinking 模型承载思考。
  if (mode === "auto" || mode === "modelVariant") {
    if (hasEffortVariant(body.model, effort)) {
      body.model = `${body.model}-${effort}`;
      return;
    }
    if (mode === "modelVariant") {
      const tv = thinkingVariantOf(body.model);
      if (tv) {
        body.model = tv;
        setThinkingBudget(body, budgetForEffort(effort));
      }
      return;
    }
  }

  // thinkingBudget 模式（可选，面向只认 Anthropic 标准 thinking 的通用中转站）：
  // 把 effort 换算成固定预算。默认 auto 模式**不走这里**——纯透传 output_config，
  // 与 Kiro 官方完全一致。
  if (mode === "thinkingBudget") {
    setThinkingBudget(body, budgetForEffort(effort));
  }
}
