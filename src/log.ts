import * as vscode from "vscode";
import { isDebug } from "./config";

let channel: vscode.OutputChannel | undefined;

export function initLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("API2Kiro");
  }
  return channel;
}

export function showLog() {
  initLog().show(true);
}

function ts(): string {
  return new Date().toISOString();
}

/** Always log (info-level), regardless of debug setting. */
export function info(...parts: unknown[]) {
  const line = `[${ts()}] ${parts.map(fmt).join(" ")}`;
  initLog().appendLine(line);
  // eslint-disable-next-line no-console
  console.log("[API2Kiro]", ...parts);
}

/** Debug-only log; no-op unless api2kiro.debug is on. */
export function debug(...parts: unknown[]) {
  if (!isDebug()) {
    return;
  }
  initLog().appendLine(`[${ts()}] [debug] ${parts.map(fmt).join(" ")}`);
}

export function error(...parts: unknown[]) {
  const line = `[${ts()}] [error] ${parts.map(fmt).join(" ")}`;
  initLog().appendLine(line);
  // eslint-disable-next-line no-console
  console.error("[API2Kiro]", ...parts);
}

function fmt(v: unknown): string {
  if (typeof v === "string") {
    return v;
  }
  try {
    return JSON.stringify(v, redactReplacer);
  } catch {
    return String(v);
  }
}

/** Redact anything that looks like a key/token when serializing debug objects. */
function redactReplacer(key: string, value: unknown): unknown {
  const k = key.toLowerCase();
  if (
    typeof value === "string" &&
    (k.includes("apikey") ||
      k.includes("api-key") ||
      k.includes("x-api-key") ||
      k.includes("authorization") ||
      k === "key" ||
      k.includes("token"))
  ) {
    return maskKey(value);
  }
  return value;
}

export function maskKey(key: string): string {
  if (!key) {
    return "";
  }
  if (key.length <= 4) {
    return "****";
  }
  if (key.length <= 8) {
    return key.slice(0, 2) + "****" + key.slice(-2);
  }
  return key.slice(0, 4) + "****" + key.slice(-4);
}
