/**
 * Types describing the CodeWhisperer request body that Kiro sends to the
 * runtime endpoint, plus the internal "CW event" objects the stream converter
 * produces (which are then serialized to the binary event-stream).
 */

export interface CwToolResult {
  toolUseId: string;
  content?: unknown;
  status?: string;
}

export interface CwToolSpec {
  toolSpecification?: {
    name?: string;
    description?: string;
    inputSchema?: { json?: AnthropicJsonSchema } | AnthropicJsonSchema;
  };
  name?: string;
  description?: string;
  inputSchema?: { json?: AnthropicJsonSchema } | AnthropicJsonSchema;
}

export interface AnthropicJsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export interface CwImage {
  format: string;
  source: { bytes: string };
}

export interface CwEditorDocument {
  text?: string;
  relativeFilePath?: string;
}

export interface CwUserInputMessageContext {
  toolResults?: CwToolResult[];
  tools?: CwToolSpec[];
  additionalContext?: Array<{ name?: string; description?: string; innerContext?: string }>;
  editorState?: {
    document?: CwEditorDocument;
    relevantDocuments?: CwEditorDocument[];
  };
  additionalModelRequestFields?: Record<string, unknown>;
}

export interface CwUserInputMessage {
  content?: string;
  modelId?: string;
  origin?: string;
  userInputMessageContext?: CwUserInputMessageContext;
  images?: CwImage[];
  documents?: Array<{ name?: string; [k: string]: unknown }>;
  additionalModelRequestFields?: Record<string, unknown>;
}

export interface CwToolUse {
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface CwAssistantResponseMessage {
  content?: string;
  toolUses?: CwToolUse[];
  /**
   * Kiro 原生历史里每轮 assistant 携带的推理内容。Kiro 直连 AWS 时用它延续
   * 工具循环中的思考。形态（实测/源码 Ut6）：嵌套 `{reasoningText:{text,signature}}`，
   * 且仅当带签名时才出现（Kiro 会 "Dropping unsigned reasoning from history"）。
   * 少数路径可能是扁平 `reasoningContent(string)+reasoningSignature`，两者都兼容。
   */
  reasoningContent?:
    | { reasoningText?: { text?: string; signature?: string } }
    | string;
  reasoningSignature?: string;
  reasoningModelId?: string;
}

export interface CwHistoryItem {
  userInputMessage?: CwUserInputMessage;
  assistantResponseMessage?: CwAssistantResponseMessage;
}

export interface CwConversationState {
  conversationId?: string;
  chatTriggerType?: string;
  history?: CwHistoryItem[];
  currentMessage?: CwHistoryItem;
  additionalModelRequestFields?: Record<string, unknown>;
}

export interface CwRequest {
  conversationState: CwConversationState;
  additionalModelRequestFields?: Record<string, unknown>;
}

/**
 * The internal, discriminated event objects produced by the stream converter.
 * Exactly one field is set per object. `writeEvent` maps each to a binary frame.
 */
export interface CwEvent {
  assistantResponseEvent?: { content: string; modelId: string };
  messageMetadataEvent?: { conversationId: string };
  toolUseEvent?: { toolUseId: string; name: string; input: string; stop?: boolean };
  reasoningContentEvent?: { text?: string; signature?: string };
  metadataEvent?: { type: string; inputTokens: number; outputTokens: number };
  contextUsageEvent?: { contextUsagePercentage: number };
}
