import * as vscode from "vscode";

export const CONFIG_NS = "api2kiro";

let extCtx: vscode.ExtensionContext | undefined;

/** 由 activate 调用,注入扩展上下文,启用「settings.json 写入失败时」的本地兜底存储。 */
export function initConfig(context: vscode.ExtensionContext): void {
  extCtx = context;
}

export function cfg() {
  return vscode.workspace.getConfiguration(CONFIG_NS);
}

const FB_PREFIX = "fallback.";

/**
 * 读字符串配置:本地兜底若存在(说明之前写 settings.json 失败,兜底为用户最新意图)优先,
 * 否则读 VS Code 设置。空字符串也算有效兜底值(用于「清除 Key」)。
 */
function readStr(key: string): string {
  const fb = extCtx?.globalState.get<string>(FB_PREFIX + key);
  if (fb !== undefined) {
    return String(fb).trim();
  }
  return (cfg().get<string>(key, "") || "").trim();
}

/**
 * 写入 api2kiro 配置:优先写 VS Code 全局设置(端点重定向等依赖它);写入抛错
 * (settings.json 不可写/损坏/受限模式)时退回插件本地存储(globalState)兜底,
 * 保证面板配置至少能持久化。返回 { settingsOk, error } 让调用方据此提示真实原因。
 */
export async function updateSetting(
  key: string,
  value: unknown
): Promise<{ settingsOk: boolean; error?: string }> {
  const setFallback = async () => {
    if (extCtx) {
      await extCtx.globalState.update(FB_PREFIX + key, value);
    }
  };
  const clearFallback = async () => {
    if (extCtx && extCtx.globalState.get(FB_PREFIX + key) !== undefined) {
      await extCtx.globalState.update(FB_PREFIX + key, undefined);
    }
  };

  try {
    await cfg().update(key, value, vscode.ConfigurationTarget.Global);
    // 关键:update() 不抛异常 ≠ 真的写进去了。实测某些环境(工作区作用域遮蔽、
    // profile / Settings Sync、或 Kiro 未持久化)会 resolve 成功却不落地,导致「假成功」。
    // 因此写完立刻回读校验:一致才算成功;不一致则退回本地兜底(readStr 优先读兜底,
    // 保证用户填的值仍能持久化),并如实报告原因。
    const readback = cfg().get(key);
    if (JSON.stringify(readback) === JSON.stringify(value)) {
      await clearFallback();
      return { settingsOk: true };
    }
    await setFallback();
    return {
      settingsOk: false,
      error: "写入后回读不一致(可能被工作区 .vscode/settings.json 遮蔽,或 Kiro 未持久化该设置)",
    };
  } catch (e) {
    await setFallback();
    return { settingsOk: false, error: (e as Error)?.message || String(e) };
  }
}

export function isEnabled(): boolean {
  const fb = extCtx?.globalState.get<boolean>(FB_PREFIX + "enabled");
  if (typeof fb === "boolean") {
    return fb;
  }
  return cfg().get<boolean>("enabled", true);
}

/** 中转模式：kiro=深度兼容(kiro2cc-proxy)；anthropic=官方 Anthropic 直通(默认 sub2api)。 */
export function getRelayMode(): "kiro" | "anthropic" {
  const fb = extCtx?.globalState.get<string>(FB_PREFIX + "mode");
  const raw = (fb !== undefined ? fb : cfg().get<string>("mode", "kiro")) || "kiro";
  return raw === "anthropic" ? "anthropic" : "kiro";
}

/** 深度兼容模式的中转站 Key。 */
export function getKiroApiKey(): string {
  return readStr("apiKey");
}

/** 官方 Anthropic 模式的 Key。 */
export function getOfficialApiKey(): string {
  return readStr("officialApiKey");
}

/** 当前生效的 Key（按模式）。 */
export function getApiKey(): string {
  return getRelayMode() === "anthropic" ? getOfficialApiKey() : getKiroApiKey();
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

/** 是否启用「上游流中断自动重试」（流断且尚未向客户端吐出任何内容时透明重发）。 */
export function getAutoRetry(): boolean {
  const fb = extCtx?.globalState.get<boolean>(FB_PREFIX + "autoRetry");
  if (typeof fb === "boolean") {
    return fb;
  }
  return cfg().get<boolean>("autoRetry", true);
}

/** 自动重试的最大重试次数（不含首次尝试），钳制在 0..5。 */
export function getMaxRetries(): number {
  const fb = extCtx?.globalState.get<number>(FB_PREFIX + "maxRetries");
  const raw = typeof fb === "number" ? fb : cfg().get<number>("maxRetries", 2);
  return Math.max(0, Math.min(5, Math.floor(raw || 0)));
}

export function getModelMapping(): Record<string, string> {
  const key = getRelayMode() === "anthropic" ? "officialModelMapping" : "modelMapping";
  return cfg().get<Record<string, string>>(key, {}) || {};
}

export function getDefaultModel(): string {
  const key = getRelayMode() === "anthropic" ? "officialDefaultModel" : "defaultModel";
  return (cfg().get<string>(key, "") || "").trim();
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
const DEFAULT_OFFICIAL_BASE_URL = "https://ai.sunnorthgod.top:2053";

function normalizeUrl(raw: string): string {
  if (!raw) {
    return "";
  }
  let r = raw;
  if (!/^https?:\/\//i.test(r)) {
    r = "https://" + r;
  }
  return r.replace(/\/+$/, "");
}

/** 深度兼容模式的中转站地址（Anthropic 格式）。 */
export function getKiroBaseUrl(): string {
  return normalizeUrl(readStr("baseUrl"));
}

/** 官方 Anthropic 模式地址（留空回落到默认 sub2api 公网地址）。 */
export function getOfficialBaseUrl(): string {
  return normalizeUrl(readStr("officialBaseUrl") || DEFAULT_OFFICIAL_BASE_URL);
}

/** 当前生效的中转站地址（按模式）。 */
export function getBaseUrl(): string {
  return getRelayMode() === "anthropic" ? getOfficialBaseUrl() : getKiroBaseUrl();
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
