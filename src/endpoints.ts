import * as vscode from "vscode";
import { info, error } from "./log";

/**
 * All AWS regions Kiro may try. We map every region to our local proxy so that
 * whichever region Kiro selects, the request lands on us.
 */
const KIRO_ALL_REGIONS = [
  "us-east-1",
  "eu-central-1",
  "us-gov-east-1",
  "us-gov-west-1",
  "us-iso-east-1",
  "us-isob-east-1",
  "us-isof-south-1",
  "us-isof-east-1",
];

const CW_CONFIG = "codewhisperer.config";

export type EndpointKey = "krsEndpoints" | "cpsEndpoints" | "endpoints";

function buildEndpointList(port: number) {
  return KIRO_ALL_REGIONS.map((region) => ({
    region,
    endpoint: `http://127.0.0.1:${port}`,
  }));
}

/**
 * Point a codewhisperer endpoint key at the local proxy (Global scope).
 * Clears any workspace/workspaceFolder overrides first so Global wins.
 * Returns true if the effective (global) value actually changed.
 */
export async function overrideEndpoint(key: EndpointKey, port: number): Promise<boolean> {
  const conf = vscode.workspace.getConfiguration(CW_CONFIG);
  const inspected = conf.inspect(key);
  const desired = buildEndpointList(port);
  let changed = false;

  if (inspected?.workspaceValue !== undefined) {
    try {
      await conf.update(key, undefined, vscode.ConfigurationTarget.Workspace);
      changed = true;
    } catch (e) {
      error(`clear workspace ${key} failed:`, (e as Error)?.message);
    }
  }
  if (inspected?.workspaceFolderValue !== undefined) {
    try {
      await conf.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      changed = true;
    } catch (e) {
      error(`clear workspaceFolder ${key} failed:`, (e as Error)?.message);
    }
  }

  const current = conf.inspect(key)?.globalValue ?? [];
  if (JSON.stringify(current) !== JSON.stringify(desired)) {
    try {
      await conf.update(key, desired, vscode.ConfigurationTarget.Global);
      info(`${key} -> 127.0.0.1:${port}`);
      changed = true;
    } catch (e) {
      error(`override ${key} failed:`, (e as Error)?.message);
      void vscode.window.showErrorMessage(
        `API2Kiro 无法写入 codewhisperer.config.${key}，请手动在 settings.json 添加：\n"codewhisperer.config.${key}": ${JSON.stringify(
          desired
        )}`
      );
    }
  }
  return changed;
}

/** Remove an endpoint override at every scope so Kiro falls back to built-ins. */
export async function restoreEndpoint(key: EndpointKey): Promise<boolean> {
  const conf = vscode.workspace.getConfiguration(CW_CONFIG);
  const inspected = conf.inspect(key);
  const targets: Array<[vscode.ConfigurationTarget, unknown, string]> = [
    [vscode.ConfigurationTarget.WorkspaceFolder, inspected?.workspaceFolderValue, "workspaceFolder"],
    [vscode.ConfigurationTarget.Workspace, inspected?.workspaceValue, "workspace"],
    [vscode.ConfigurationTarget.Global, inspected?.globalValue, "global"],
  ];
  let changed = false;
  for (const [target, value, label] of targets) {
    if (value === undefined) {
      continue;
    }
    try {
      await conf.update(key, undefined, target);
      info(`${key} removed at ${label}`);
      changed = true;
    } catch (e) {
      error(`restore ${key} at ${label} failed:`, (e as Error)?.message);
    }
  }
  return changed;
}

/**
 * Detect Kiro >= 1.0, which also honors the generic "endpoints" key. On older
 * builds we simply clear it. We can't read Kiro's version reliably from the
 * extension host, so we always override all three keys defensively.
 * Returns true if any effective value changed (a window reload is then needed).
 */
export async function applyOverrides(krsPort: number, cpsPort: number): Promise<boolean> {
  const a = await overrideEndpoint("endpoints", krsPort);
  const b = await overrideEndpoint("krsEndpoints", krsPort);
  const c = await overrideEndpoint("cpsEndpoints", cpsPort);
  return a || b || c;
}

export async function restoreAll(): Promise<boolean> {
  const a = await restoreEndpoint("endpoints");
  const b = await restoreEndpoint("krsEndpoints");
  const c = await restoreEndpoint("cpsEndpoints");
  return a || b || c;
}
