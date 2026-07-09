import * as vscode from "vscode";
import { cfg } from "./config";
import { CwRequest } from "./cwTypes";
import { EFFORT_LEVELS, EffortLevel } from "./modelStore";
import { debug } from "./log";

const VALID_EFFORTS = new Set<string>(EFFORT_LEVELS as readonly string[]);

export type EffortMode = "off" | "modelVariant" | "thinkingBudget" | "auto";

export function getEffortMode(): EffortMode {
  const m = cfg().get<string>("effortMode", "auto");
  if (m === "off" || m === "modelVariant" || m === "thinkingBudget") {
    return m;
  }
  return "auto";
}

const DEFAULT_BUDGETS: Record<EffortLevel, number> = {
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 24576,
};

/** Thinking token budget for an effort level (config override + sane defaults). */
export function budgetForEffort(effort: string): number {
  const e = normEffort(effort);
  if (!e) {
    return 0;
  }
  const override = cfg().get<Record<string, number>>("effortBudgets", {}) || {};
  const v = Number(override[e]);
  if (Number.isFinite(v) && v > 0) {
    return v;
  }
  return DEFAULT_BUDGETS[e];
}

export function normEffort(x: unknown): EffortLevel | undefined {
  if (typeof x !== "string") {
    return undefined;
  }
  const v = x.trim().toLowerCase();
  return VALID_EFFORTS.has(v) ? (v as EffortLevel) : undefined;
}

/** Extract the effort Kiro attached to the request (output_config.effort / reasoning.effort). */
export function effortFromRequest(req: CwRequest): EffortLevel | undefined {
  const cm = req?.conversationState?.currentMessage?.userInputMessage;
  const candidates = [
    cm?.userInputMessageContext?.additionalModelRequestFields,
    cm?.additionalModelRequestFields,
    req?.additionalModelRequestFields,
    req?.conversationState?.additionalModelRequestFields,
  ];
  for (const fields of candidates) {
    if (!fields || typeof fields !== "object") {
      continue;
    }
    const f = fields as {
      output_config?: { effort?: unknown };
      reasoning?: { effort?: unknown };
    };
    const e = normEffort(f.output_config?.effort ?? f.reasoning?.effort);
    if (e) {
      return e;
    }
  }
  return undefined;
}

/**
 * Resolve the effort level for a request: prefer the value embedded in the
 * request; fall back to Kiro's current effort-level command; finally fall back
 * to the last-known effort for this conversation.
 *
 * The per-conversation cache is important for extended "think a step, act a
 * step": tool-continuation turns may omit output_config.effort, and the
 * getEffortLevel command isn't available on every Kiro build. Without the
 * cache, thinking effort would silently drop on later turns of an agent loop.
 */
const effortCache = new Map<string, EffortLevel>();

export async function getSelectedEffort(req: CwRequest): Promise<EffortLevel | undefined> {
  const convId = req?.conversationState?.conversationId || "";

  const fromReq = effortFromRequest(req);
  if (fromReq) {
    if (convId) {
      effortCache.set(convId, fromReq);
    }
    return fromReq;
  }
  try {
    const v = await vscode.commands.executeCommand("kiro.agentModels.getEffortLevel");
    const e = normEffort(v);
    if (e) {
      debug("effort from command", e);
      if (convId) {
        effortCache.set(convId, e);
      }
      return e;
    }
  } catch {
    /* command unavailable on this Kiro build */
  }
  if (convId && effortCache.has(convId)) {
    const cached = effortCache.get(convId);
    debug("effort from conversation cache", cached);
    return cached;
  }
  return undefined;
}
