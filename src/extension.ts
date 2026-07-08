import * as vscode from "vscode";
import { CONFIG_NS, isEnabled, getApiKey, getBaseUrl, getPort, getCpsPort } from "./config";
import { initLog, showLog, info, error } from "./log";
import { KrsProxyServer } from "./krsServer";
import { CpsProxyServer } from "./cpsServer";
import { applyOverrides, restoreAll } from "./endpoints";
import { SidebarProvider } from "./sidebar";

let krsServer: KrsProxyServer | undefined;
let cpsServer: CpsProxyServer | undefined;
let krsPort = 0;
let cpsPort = 0;
let statusBar: vscode.StatusBarItem | undefined;
let sidebar: SidebarProvider | undefined;
let reloadPrompted = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLog();
  info("activating, version", context.extension.packageJSON.version);

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "api2kiro.focusSidebar";
  context.subscriptions.push(statusBar);

  sidebar = new SidebarProvider(context, () => ({ krsPort, cpsPort }));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  registerCommands(context);

  if (isEnabled()) {
    await startAndOverride(context, false);
  } else {
    await restoreAll();
    updateStatusBar();
  }

  // React to config changes.
  const watcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (!e.affectsConfiguration(CONFIG_NS)) {
      return;
    }
    const enableChanged = e.affectsConfiguration(`${CONFIG_NS}.enabled`);
    if (enableChanged) {
      if (isEnabled()) {
        await startAndOverride(context, true);
      } else {
        await stopServers();
        const changed = await restoreAll();
        updateStatusBar();
        if (changed) {
          promptReload("已关闭代理");
        }
      }
    }
    updateStatusBar();
    sidebar?.postAll();
  });
  context.subscriptions.push(watcher);

  updateStatusBar();
}

export async function deactivate(): Promise<void> {
  // Just release our port hold. Do NOT restore the Global endpoint config here:
  // other Kiro windows may still be running and depend on it, and a standby
  // window will take over the port. The overrides are only cleared when the
  // user explicitly disables the proxy (see the config watcher).
  await stopServers();
  statusBar?.dispose();
}

async function startAndOverride(context: vscode.ExtensionContext, fromToggle: boolean): Promise<void> {
  try {
    krsPort = getPort();
    cpsPort = getCpsPort();
    if (!krsServer) {
      krsServer = new KrsProxyServer(context, krsPort, () => onOwnershipChanged());
      await krsServer.start();
    }
    if (!cpsServer) {
      cpsServer = new CpsProxyServer(cpsPort, () => onOwnershipChanged());
      await cpsServer.start();
    }
  } catch (e) {
    error("failed to start servers:", (e as Error).message);
    void vscode.window.showErrorMessage("API2Kiro 启动本地代理失败：" + (e as Error).message);
    updateStatusBar();
    return;
  }

  // Warn only if a NON-API2Kiro process squats our ports (can't share).
  if (krsServer?.hadForeignConflict() || cpsServer?.hadForeignConflict()) {
    void vscode.window.showWarningMessage(
      `API2Kiro 端口 ${krsPort}/${cpsPort} 被其他程序占用，无法启动代理。请在设置里改用其它端口，或关闭占用程序。`
    );
  }

  // Endpoint overrides use FIXED ports, so every Kiro window writes the SAME
  // Global config — no clobbering. The first window to bind the ports serves
  // all windows; the rest are warm standbys that take over if it exits.
  let changed = false;
  try {
    changed = await applyOverrides(krsPort, cpsPort);
  } catch (e) {
    error("failed to override endpoints:", (e as Error).message);
  }

  updateStatusBar();
  sidebar?.postAll();

  if (changed || fromToggle) {
    promptReload("代理已启用");
  }
}

/** Called when this window's PortHolder gains ownership (a former owner exited). */
function onOwnershipChanged(): void {
  info("ownership changed; this window is now (or still) serving requests");
  updateStatusBar();
  sidebar?.postAll();
}

async function stopServers(): Promise<void> {
  if (krsServer) {
    await krsServer.stop();
    krsServer = undefined;
  }
  if (cpsServer) {
    await cpsServer.stop();
    cpsServer = undefined;
  }
}

function promptReload(reason: string): void {
  if (reloadPrompted) {
    return;
  }
  reloadPrompted = true;
  void vscode.window
    .showInformationMessage(
      `${reason}。需要重新加载窗口，Kiro 才会重新读取端点配置并刷新模型列表。`,
      "重新加载窗口",
      "稍后"
    )
    .then((choice) => {
      reloadPrompted = false;
      if (choice === "重新加载窗口") {
        void vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    });
}

function updateStatusBar(): void {
  if (!statusBar) {
    return;
  }
  const enabled = isEnabled();
  const configured = !!getApiKey() && !!getBaseUrl();
  const owner = krsServer?.isOwner() || cpsServer?.isOwner();
  const foreign = krsServer?.hadForeignConflict() || cpsServer?.hadForeignConflict();
  if (!enabled) {
    statusBar.text = "$(circle-slash) API2Kiro 关闭";
    statusBar.tooltip = "代理已关闭，Kiro 使用官方服务";
  } else if (!configured) {
    statusBar.text = "$(warning) API2Kiro 未配置";
    statusBar.tooltip = "点击打开控制面板，填写中转站地址与 API Key";
  } else if (foreign) {
    statusBar.text = "$(error) API2Kiro 端口冲突";
    statusBar.tooltip = `端口 ${krsPort}/${cpsPort} 被其他程序占用，请更换端口`;
  } else if (owner) {
    statusBar.text = "$(rocket) API2Kiro";
    statusBar.tooltip = `代理运行中（本窗口为主实例）· KRS ${krsPort} / CPS ${cpsPort}`;
  } else {
    statusBar.text = "$(rocket) API2Kiro 待命";
    statusBar.tooltip = `已连接到本机主实例 · KRS ${krsPort} / CPS ${cpsPort}（本窗口待命，主实例退出后自动接管）`;
  }
  statusBar.show();
}

function registerCommands(context: vscode.ExtensionContext): void {
  const conf = () => vscode.workspace.getConfiguration(CONFIG_NS);

  context.subscriptions.push(
    vscode.commands.registerCommand("api2kiro.focusSidebar", () => {
      void vscode.commands.executeCommand("api2kiro.panel.focus");
    }),
    vscode.commands.registerCommand("api2kiro.refreshUsage", () => {
      void sidebar?.refresh();
    }),
    vscode.commands.registerCommand("api2kiro.openLog", () => showLog()),
    vscode.commands.registerCommand("api2kiro.toggleEnabled", async () => {
      await conf().update("enabled", !isEnabled(), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand("api2kiro.setBaseUrl", async () => {
      const value = await vscode.window.showInputBox({
        title: "设置中转站地址",
        prompt: "Anthropic 端点格式，例如 https://your-relay.com/v1",
        value: getBaseUrl(),
        ignoreFocusOut: true,
      });
      if (value !== undefined) {
        await conf().update("baseUrl", value.trim(), vscode.ConfigurationTarget.Global);
        sidebar?.postAll();
      }
    }),
    vscode.commands.registerCommand("api2kiro.setApiKey", async () => {
      const value = await vscode.window.showInputBox({
        title: "设置 API Key",
        prompt: "中转站 API Key（sk-...）",
        password: true,
        ignoreFocusOut: true,
      });
      if (value !== undefined) {
        await conf().update("apiKey", value.trim(), vscode.ConfigurationTarget.Global);
        sidebar?.postAll();
      }
    })
  );
}
