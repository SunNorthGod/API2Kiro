import { getApiKey, getBaseUrl, getUsagePath, resolveRootUrl } from "./config";
import { getJson } from "./upstream";
import { debug, error } from "./log";

export interface RelayModelUsage {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface RelayCacheStats {
  /** Requests that carried cache accounting fields. */
  records: number;
  /** Sum of cache_read_input_tokens across records. */
  cacheReadTokens: number;
  /** Sum of cache_creation_input_tokens across records. */
  cacheCreationTokens: number;
  /**
   * Total prompt tokens = sum of inputTokens. In kiro2cc-proxy `inputTokens`
   * already INCLUDES cached tokens (it stores final_input_tokens, the full
   * prompt size), so the hit rate is cacheRead / totalInput — NOT
   * cacheRead / (input + cacheRead + creation).
   */
  totalInputTokens: number;
  /** cacheReadTokens / totalInputTokens, or null when there's no data. */
  hitRate: number | null;
}

export interface RelayUsage {
  ok: boolean;
  source?: "kiro2cc" | "billing";
  name?: string;
  spendingLimit?: number | null; // null = unlimited
  expiresAt?: string | null; // RFC3339
  totalRequests?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCost?: number;
  byModel?: RelayModelUsage[];
  cache?: RelayCacheStats; // authoritative cache stats from server records
  errorMessage?: string;
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Aggregate authoritative cache stats from the paged records endpoint
 * `GET /api/user/usage/records`. Each record carries cacheReadInputTokens /
 * cacheCreationInputTokens, and inputTokens is the FULL prompt size (cache
 * included), so hitRate = sum(cacheRead) / sum(inputTokens).
 */
async function fetchCacheStats(): Promise<RelayCacheStats | undefined> {
  const apiKey = getApiKey();
  const url = resolveRootUrl("/api/user/usage/records?page=1&page_size=500");
  try {
    const data = (await getJson(url, { "x-api-key": apiKey })) as { records?: unknown[] };
    const records = Array.isArray(data.records) ? data.records : [];
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let totalInputTokens = 0;
    let counted = 0;
    for (const r of records) {
      if (!r || typeof r !== "object") {
        continue;
      }
      const rec = r as Record<string, unknown>;
      totalInputTokens += Number(rec.inputTokens) || 0;
      if (rec.cacheReadInputTokens != null || rec.cacheCreationInputTokens != null) {
        counted += 1;
      }
      cacheReadTokens += Number(rec.cacheReadInputTokens) || 0;
      cacheCreationTokens += Number(rec.cacheCreationInputTokens) || 0;
    }
    const hitRate = totalInputTokens > 0 ? Math.min(1, cacheReadTokens / totalInputTokens) : null;
    return { records: counted, cacheReadTokens, cacheCreationTokens, totalInputTokens, hitRate };
  } catch (e) {
    debug("cache stats fetch failed:", (e as Error).message);
    return undefined;
  }
}

/**
 * kiro2cc-proxy style dashboard API: `GET /api/user/usage` authenticated with
 * the `x-api-key` header. Returns the same figures the relay's /user page shows,
 * plus authoritative cache stats aggregated from the records endpoint.
 */
async function fetchKiro2ccUsage(): Promise<RelayUsage> {
  const apiKey = getApiKey();
  const url = resolveRootUrl("/api/user/usage");
  const [data, cache] = await Promise.all([
    getJson(url, { "x-api-key": apiKey }) as Promise<Record<string, unknown>>,
    fetchCacheStats(),
  ]);
  const byModel = Array.isArray(data.byModel)
    ? (data.byModel as Record<string, unknown>[]).map((m) => ({
        model: String(m.model ?? ""),
        requests: Number(m.requests) || 0,
        inputTokens: Number(m.inputTokens) || 0,
        outputTokens: Number(m.outputTokens) || 0,
        cost: Number(m.cost) || 0,
      }))
    : [];
  return {
    ok: true,
    source: "kiro2cc",
    name: typeof data.name === "string" ? data.name : undefined,
    spendingLimit: data.spendingLimit == null ? null : Number(data.spendingLimit),
    expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : null,
    totalRequests: Number(data.totalRequests) || 0,
    totalInputTokens: Number(data.totalInputTokens) || 0,
    totalOutputTokens: Number(data.totalOutputTokens) || 0,
    totalCost: Number(data.totalCost) || 0,
    byModel,
    cache,
  };
}

/**
 * Legacy OpenAI/New-API billing style: subscription (limit) + usage (spent).
 * Used only when the user explicitly configures a usagePath.
 */
async function fetchBillingUsage(subPath: string): Promise<RelayUsage> {
  const apiKey = getApiKey();
  const authHeaders = { Authorization: "Bearer " + apiKey };
  const subUrl = subPath.startsWith("http") ? subPath : resolveRootUrl(subPath);
  const sub = (await getJson(subUrl, authHeaders)) as Record<string, unknown>;
  const spendingLimit = Number(sub.hard_limit_usd ?? sub.hard_limit ?? sub.total_granted ?? 0) || 0;
  const accessUntil = Number(sub.access_until ?? 0) || 0;

  let usedUsd = 0;
  const usagePath = subPath.replace(/subscription\/?$/, "usage");
  if (usagePath !== subPath) {
    try {
      const start = "2020-01-01";
      const end = ymd(new Date(Date.now() + 86400000));
      const usageUrl =
        (usagePath.startsWith("http") ? usagePath : resolveRootUrl(usagePath)) +
        `?start_date=${start}&end_date=${end}`;
      const usage = (await getJson(usageUrl, authHeaders)) as Record<string, unknown>;
      usedUsd = (Number(usage.total_usage) || 0) / 100;
    } catch (e) {
      debug("billing usage total failed:", (e as Error).message);
    }
  }
  return {
    ok: true,
    source: "billing",
    totalCost: usedUsd,
    spendingLimit: spendingLimit > 0 ? spendingLimit : null,
    expiresAt: accessUntil > 0 ? new Date(accessUntil * 1000).toISOString() : null,
  };
}

/**
 * Query relay usage. Defaults to the kiro2cc-proxy dashboard API; if the user
 * set a custom usagePath, use the OpenAI/New-API billing endpoints instead.
 */
export async function fetchRelayUsage(): Promise<RelayUsage> {
  const apiKey = getApiKey();
  if (!apiKey || !getBaseUrl()) {
    return { ok: false, errorMessage: "未配置中转站地址或 API Key" };
  }
  const usagePath = getUsagePath();
  try {
    return usagePath ? await fetchBillingUsage(usagePath) : await fetchKiro2ccUsage();
  } catch (e) {
    error("usage fetch failed:", (e as Error).message);
    return { ok: false, errorMessage: (e as Error).message };
  }
}
