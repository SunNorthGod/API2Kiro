import * as vscode from "vscode";

export const CONFIG_NS = "api2kiro";

export function cfg() {
  return vscode.workspace.getConfiguration(CONFIG_NS);
}

export function isEnabled(): boolean {
  return cfg().get<boolean>("enabled", true);
}

export function getApiKey(): string {
  return (cfg().get<string>("apiKey", "") || "").trim();
}

export function getPort(): number {
  return cfg().get<number>("port", 19800) || 19800;
}

export function getCpsPort(): number {
  return cfg().get<number>("cpsPort", 19801) || 19801;
}

export function getMaxTokens(): number {
  return cfg().get<number>("maxTokens", 32000) || 32000;
}

export function isDebug(): boolean {
  return cfg().get<boolean>("debug", false);
}

export function getInterceptIntentClassifier(): boolean {
  return cfg().get<boolean>("interceptIntentClassifier", true);
}

export function getModelMapping(): Record<string, string> {
  return cfg().get<Record<string, string>>("modelMapping", {}) || {};
}

export function getDefaultModel(): string {
  return (cfg().get<string>("defaultModel", "") || "").trim();
}

export function getUsagePath(): string {
  return (cfg().get<string>("usagePath", "") || "").trim();
}

export interface ThinkingConfig {
  // "enabled"：固定预算思考（budget_tokens，仅 thinkingBudget 模式用）；"disabled"：关闭。
  // 注：默认 auto 模式不发 thinking，只透传 Kiro 原生 output_config.effort。
  type: "enabled" | "disabled";
  budget_tokens?: number;
}

export function getThinkingConfig(): ThinkingConfig | undefined {
  const c = cfg();
  const mode = c.get<string>("thinking", "auto");
  if (mode === "disabled") {
    return { type: "disabled" };
  }
  if (mode === "enabled") {
    return { type: "enabled", budget_tokens: c.get<number>("thinkingBudget", 8192) };
  }
  return undefined; // auto
}

export function getThinkingBudget(): number {
  return cfg().get<number>("thinkingBudget", 8192) || 8192;
}

/**
 * 用户覆盖的 reasoning 思考模式（GPT 5.6：standard / pro）。
 * - "auto"（默认）：不强制，透传 Kiro 请求里的 mode（若有），否则用中转站/上游默认（standard）。
 * - "standard" / "pro"：强制该模式。仅对 reasoning 模型（GPT）生效；非 reasoning 模型中转站会忽略。
 * 返回 undefined 表示 auto（不覆盖）。
 */
export function getReasoningModeOverride(): string | undefined {
  const v = (cfg().get<string>("reasoningMode", "auto") || "auto").trim().toLowerCase();
  return v === "standard" || v === "pro" ? v : undefined;
}

/**
 * Normalize the configured relay base URL.
 * Accepts forms like:
 *   https://host            -> https://host
 *   https://host/v1         -> https://host/v1
 *   https://host:8443/v1/   -> https://host:8443/v1
 * Returns "" when not configured.
 */
export function getBaseUrl(): string {
  let raw = (cfg().get<string>("baseUrl", "") || "").trim();
  if (!raw) {
    return "";
  }
  if (!/^https?:\/\//i.test(raw)) {
    raw = "https://" + raw;
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Resolve the full URL for a relative Anthropic-style API path (e.g. "/messages"
 * or "/models"). If the base already ends with /v1 we append the path directly,
 * otherwise we insert /v1.
 */
export function resolveApiUrl(apiPath: string): string {
  const base = getBaseUrl();
  if (!base) {
    return "";
  }
  const p = apiPath.startsWith("/") ? apiPath : "/" + apiPath;
  if (/\/v\d+$/i.test(base)) {
    return base + p;
  }
  return base + "/v1" + p;
}

/**
 * Resolve a URL for an absolute-ish path relative to the relay ROOT (strips any
 * trailing /v1). Used for usage endpoints that may or may not include /v1.
 */
export function resolveRootUrl(path: string): string {
  const base = getBaseUrl();
  if (!base) {
    return "";
  }
  const root = base.replace(/\/v\d+$/i, "");
  const p = path.startsWith("/") ? path : "/" + path;
  return root + p;
}
