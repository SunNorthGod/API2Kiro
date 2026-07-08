import * as vscode from "vscode";
import { CONFIG_NS, getApiKey, getBaseUrl, isEnabled, resolveRootUrl } from "./config";
import { maskKey } from "./log";
import { fetchRelayUsage } from "./usage";
import { fetchRelayModels } from "./modelStore";

export interface PortInfo {
  krsPort: number;
  cpsPort: number;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "api2kiro.panel";

  private view?: vscode.WebviewView;
  private context: vscode.ExtensionContext;
  private getPorts: () => PortInfo;

  constructor(context: vscode.ExtensionContext, getPorts: () => PortInfo) {
    this.context = context;
    this.getPorts = getPorts;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.postAll();
      }
    });
    this.postAll();
  }

  reveal(): void {
    if (this.view) {
      this.view.show?.(true);
    } else {
      void vscode.commands.executeCommand("api2kiro.panel.focus");
    }
  }

  private async onMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    const conf = vscode.workspace.getConfiguration(CONFIG_NS);
    switch (msg.type) {
      case "ready":
        this.postAll();
        break;
      case "saveConfig": {
        const baseUrl = String(msg.baseUrl ?? "").trim();
        const apiKey = String(msg.apiKey ?? "").trim();
        await conf.update("baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
        if (apiKey) {
          await conf.update("apiKey", apiKey, vscode.ConfigurationTarget.Global);
        }
        this.toast("ok", "已保存配置");
        this.postState();
        void this.refresh();
        break;
      }
      case "clearKey":
        await conf.update("apiKey", "", vscode.ConfigurationTarget.Global);
        this.toast("ok", "已清除 API Key");
        this.postState();
        break;
      case "toggleEnabled":
        await conf.update("enabled", !!msg.enabled, vscode.ConfigurationTarget.Global);
        break;
      case "refresh":
        void this.refresh();
        break;
      case "openLog":
        await vscode.commands.executeCommand("api2kiro.openLog");
        break;
      case "openUsageWeb": {
        const url = resolveRootUrl("/user");
        if (url) {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        } else {
          this.toast("error", "请先填写中转站地址");
        }
        break;
      }
    }
  }

  postAll(): void {
    this.postState();
    void this.refresh();
  }

  private postState(): void {
    const key = getApiKey();
    const ports = this.getPorts();
    this.post({
      type: "state",
      enabled: isEnabled(),
      hasKey: !!key,
      maskedKey: maskKey(key),
      baseUrl: getBaseUrl(),
      krsPort: ports.krsPort,
      cpsPort: ports.cpsPort,
      usageWebUrl: resolveRootUrl("/user"),
    });
  }

  /** Fetch relay usage + model count and push to the webview. */
  async refresh(): Promise<void> {
    if (!getApiKey() || !getBaseUrl()) {
      this.post({ type: "usage", ok: false, errorMessage: "未配置" });
      this.post({ type: "models", count: null });
      return;
    }
    fetchRelayModels(true)
      .then((models) => this.post({ type: "models", count: Array.isArray(models) ? models.length : null }))
      .catch(() => this.post({ type: "models", count: null }));

    const usage = await fetchRelayUsage().catch((e) => ({ ok: false, errorMessage: (e as Error).message }));
    this.post({ type: "usage", ...usage });
  }

  private toast(level: "ok" | "error", message: string): void {
    this.post({ type: "toast", level, message });
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root {
    --fg: var(--vscode-foreground);
    --muted: var(--vscode-descriptionForeground, #8b8b8b);
    --card: var(--vscode-editorWidget-background, #1e1e1e);
    --card2: var(--vscode-editor-background, #181818);
    --border: var(--vscode-panel-border, #333);
    --accent: var(--vscode-button-background, #7c5cff);
    --accent-fg: var(--vscode-button-foreground, #fff);
    --accent-hover: var(--vscode-button-hoverBackground, #8f74ff);
    --ghost-bg: var(--vscode-button-secondaryBackground, rgba(255,255,255,.06));
    --ghost-fg: var(--vscode-button-secondaryForeground, var(--fg));
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #555);
    --green: #3fb950; --yellow: #d29922; --red: #f85149;
  }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); padding: 10px; }
  h3 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .3px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
  .cardhead { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 8px; }
  .row { display: flex; align-items: center; justify-content: space-between; padding: 3px 0; gap: 8px; }
  .key { color: var(--muted); }
  .val { font-weight: 600; text-align: right; word-break: break-all; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 8px 0 4px; }
  input { width: 100%; padding: 8px 10px; border: 1px solid var(--input-border); border-radius: 7px; background: var(--input-bg); color: var(--input-fg); font-size: 13px; outline: none; }
  input:focus { border-color: var(--accent); }

  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 14px; border: 1px solid transparent; border-radius: 7px; font-size: 12px; font-weight: 600; cursor: pointer; transition: background .15s, border-color .15s, transform .05s; }
  .btn:active { transform: translateY(1px); }
  .btn-primary { background: var(--accent); color: var(--accent-fg); flex: 1; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-ghost { background: var(--ghost-bg); color: var(--ghost-fg); border-color: var(--border); }
  .btn-ghost:hover { border-color: var(--accent); }
  .btns { display: flex; gap: 8px; margin-top: 10px; }
  .iconbtn { background: transparent; border: 1px solid var(--border); color: var(--fg); border-radius: 6px; width: 26px; height: 26px; cursor: pointer; font-size: 13px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
  .iconbtn:hover { border-color: var(--accent); color: var(--accent); }

  .badge { display: inline-block; padding: 2px 9px; border-radius: 20px; font-size: 11px; font-weight: 600; }
  .badge-on { background: rgba(63,185,80,.16); color: var(--green); }
  .badge-off { background: rgba(248,81,73,.16); color: var(--red); }
  .badge-name { background: rgba(124,92,255,.16); color: var(--accent); }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .stat { background: var(--card2); border: 1px solid var(--border); border-radius: 8px; padding: 9px 10px; }
  .stat .t { color: var(--muted); font-size: 11px; margin-bottom: 3px; }
  .stat .v { font-size: 17px; font-weight: 700; }
  .stat .v.cost { color: var(--green); }

  .bar-wrap { height: 7px; background: var(--input-bg); border: 1px solid var(--border); border-radius: 5px; overflow: hidden; margin: 8px 0 4px; }
  .bar { height: 100%; width: 0%; transition: width .4s; background: var(--green); }

  .mrow { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 0; border-top: 1px dashed var(--border); }
  .mrow:first-of-type { border-top: none; }
  .mname { font-weight: 600; font-size: 12px; }
  .msub { color: var(--muted); font-size: 11px; }
  .mcost { color: var(--green); font-weight: 600; font-size: 12px; }

  .switch { position: relative; display: inline-block; width: 40px; height: 22px; }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider { position: absolute; inset: 0; cursor: pointer; background: var(--input-bg); border: 1px solid var(--input-border); border-radius: 12px; transition: .2s; }
  .slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 2px; top: 2px; background: var(--muted); border-radius: 50%; transition: .2s; }
  .switch input:checked + .slider { background: var(--accent); }
  .switch input:checked + .slider:before { transform: translateX(18px); background: var(--accent-fg); }

  .big { font-size: 26px; font-weight: 700; text-align: center; }
  .muted { color: var(--muted); font-size: 11px; }
  .hint { font-size: 11px; color: var(--muted); margin-top: 8px; line-height: 1.5; }
  .link { color: var(--accent); cursor: pointer; font-size: 12px; background: none; border: none; padding: 0; }
  .hidden { display: none !important; }
  .toast { position: fixed; left: 10px; right: 10px; bottom: 10px; padding: 9px 12px; border-radius: 7px; color: #fff; font-size: 12px; opacity: 0; transition: .25s; pointer-events: none; text-align: center; }
  .toast.show { opacity: 1; }
  .toast.ok { background: #2ea043; } .toast.error { background: #da3633; }
</style>
</head>
<body>
  <div class="cardhead" style="margin-bottom:12px;">
    <div style="display:flex;align-items:center;gap:8px;">
      <h3 style="font-size:15px;">API2Kiro</h3>
      <span class="badge" id="statusBadge">--</span>
    </div>
    <label class="switch" title="启用/关闭代理"><input type="checkbox" id="enable"><span class="slider"></span></label>
  </div>

  <div class="card">
    <label>中转站地址（Anthropic 格式）</label>
    <input type="text" id="baseUrl" placeholder="https://your-relay.com/v1" autocomplete="off" spellcheck="false">
    <label>API Key</label>
    <input type="password" id="apiKey" placeholder="sk-..." autocomplete="off" spellcheck="false">
    <div class="muted" id="keyHint" style="margin-top:6px;"></div>
    <div class="btns">
      <button class="btn btn-primary" id="save">保存并启用</button>
      <button class="btn btn-ghost" id="clear">清除 Key</button>
    </div>
  </div>

  <div class="card">
    <div class="cardhead">
      <div style="display:flex;align-items:center;gap:8px;">
        <h3>用量</h3>
        <span class="badge badge-name hidden" id="acctName"></span>
      </div>
      <button class="iconbtn" id="refresh" title="刷新">&#8635;</button>
    </div>

    <div id="usageError" class="muted hidden"></div>

    <div id="usageBody">
      <div class="grid">
        <div class="stat"><div class="t">总请求数</div><div class="v" id="uReq">--</div></div>
        <div class="stat"><div class="t">总费用</div><div class="v cost" id="uCost">--</div></div>
        <div class="stat"><div class="t">输入 Tokens</div><div class="v" id="uIn">--</div></div>
        <div class="stat"><div class="t">输出 Tokens</div><div class="v" id="uOut">--</div></div>
      </div>

      <div id="limitRow" class="hidden">
        <div class="row" style="margin-top:8px;"><span class="key">已用 / 额度</span><span class="val" id="uLimit">--</span></div>
        <div class="bar-wrap"><div class="bar" id="uBar"></div></div>
      </div>
      <div class="row" id="expiryRow"><span class="key">有效期</span><span class="val" id="uExpiry">永久 / 不限</span></div>
      <div class="row"><span class="key">可用模型</span><span class="val" id="modelCount">--</span></div>

      <div id="byModelWrap" style="margin-top:8px;">
        <div class="muted" style="margin-bottom:2px;">按模型分组</div>
        <div id="byModel"></div>
      </div>
    </div>

    <div class="btns">
      <button class="btn btn-ghost" id="usageWeb" style="flex:1;">网页用量面板</button>
    </div>
  </div>

  <div class="card">
    <div class="cardhead">
      <div style="display:flex;align-items:center;gap:8px;">
        <h3>缓存命中率</h3>
        <span class="badge badge-name">权威</span>
      </div>
      <button class="iconbtn" id="refreshCache" title="刷新">&#8635;</button>
    </div>
    <div class="big" id="hitRate">--</div>
    <div class="muted" style="text-align:center;">缓存读取 token / 总输入 token（来自中转站明细）</div>
    <div class="bar-wrap"><div class="bar" id="hitBar"></div></div>
    <div class="row"><span class="key">缓存读取</span><span class="val" id="cacheRead">0</span></div>
    <div class="row"><span class="key">缓存写入</span><span class="val" id="cacheCreate">0</span></div>
    <div class="row"><span class="key">总输入 token</span><span class="val" id="cacheTotal">0</span></div>
    <div class="row"><span class="key">统计请求数</span><span class="val" id="cacheRecords">0</span></div>
    <div class="hint">缓存命中越高越省额度：尽量在同一会话内连续对话，别频繁新开会话。数据取自中转站，最多统计最近 500 条请求。</div>
  </div>

  <div class="card">
    <div class="row"><span class="key">本地端口</span><span class="val" id="ports">--</span></div>
    <div class="btns"><button class="btn btn-ghost" id="log" style="flex:1;">打开日志</button></div>
  </div>

  <div class="toast" id="toast"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let toastTimer = 0;
  const fmt = (n) => (Number(n) || 0).toLocaleString('en-US');
  const usd = (n) => '$' + (Number(n) || 0).toFixed(4);
  const pct = (x) => (x * 100).toFixed(1) + '%';
  const show = (el, on) => el.classList.toggle('hidden', !on);

  function toast(level, msg) {
    const t = $('toast'); t.textContent = msg; t.className = 'toast show ' + level;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  $('save').addEventListener('click', () => vscode.postMessage({ type: 'saveConfig', baseUrl: $('baseUrl').value, apiKey: $('apiKey').value }));
  $('clear').addEventListener('click', () => vscode.postMessage({ type: 'clearKey' }));
  $('refresh').addEventListener('click', () => { $('refresh').textContent = '…'; vscode.postMessage({ type: 'refresh' }); });
  $('refreshCache').addEventListener('click', () => { $('refreshCache').textContent = '…'; vscode.postMessage({ type: 'refresh' }); });
  $('log').addEventListener('click', () => vscode.postMessage({ type: 'openLog' }));
  $('usageWeb').addEventListener('click', () => vscode.postMessage({ type: 'openUsageWeb' }));
  $('enable').addEventListener('change', (e) => vscode.postMessage({ type: 'toggleEnabled', enabled: e.target.checked }));

  function fmtDate(iso) {
    const d = new Date(iso); if (isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate());
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'state') {
      $('enable').checked = !!m.enabled;
      const b = $('statusBadge');
      if (!m.enabled) { b.textContent = '已关闭'; b.className = 'badge badge-off'; }
      else if (!m.hasKey || !m.baseUrl) { b.textContent = '未配置'; b.className = 'badge badge-off'; }
      else { b.textContent = '运行中'; b.className = 'badge badge-on'; }
      if (m.baseUrl) $('baseUrl').value = m.baseUrl;
      $('keyHint').textContent = m.hasKey ? ('已配置 Key：' + m.maskedKey) : '尚未配置 Key';
      $('ports').textContent = 'KRS ' + m.krsPort + ' / CPS ' + m.cpsPort;
      show($('usageWeb'), !!m.usageWebUrl);
    } else if (m.type === 'usage') {
      $('refresh').innerHTML = '&#8635;';
      $('refreshCache').innerHTML = '&#8635;';
      const bad = !m.ok;
      show($('usageError'), bad);
      show($('usageBody'), !bad);
      // cache card
      const c = m.cache;
      if (c && c.hitRate != null) {
        $('hitRate').textContent = pct(c.hitRate);
        const p = Math.max(0, Math.min(100, c.hitRate * 100));
        $('hitBar').style.width = p + '%';
        $('hitBar').style.background = p >= 60 ? 'var(--green)' : p >= 30 ? 'var(--yellow)' : 'var(--red)';
        $('cacheRead').textContent = fmt(c.cacheReadTokens);
        $('cacheCreate').textContent = fmt(c.cacheCreationTokens);
        $('cacheTotal').textContent = fmt(c.totalInputTokens);
        $('cacheRecords').textContent = fmt(c.records);
      } else if (!bad) {
        $('hitRate').textContent = '--';
        $('hitBar').style.width = '0%';
        $('cacheRead').textContent = '0'; $('cacheCreate').textContent = '0';
        $('cacheTotal').textContent = '0'; $('cacheRecords').textContent = '0';
      }
      if (bad) {
        $('usageError').textContent = '用量获取失败：' + (m.errorMessage || '未知') + '（可点下方按钮看网页面板）';
        show($('acctName'), false);
        return;
      }
      if (m.name) { $('acctName').textContent = m.name; show($('acctName'), true); }
      $('uReq').textContent = fmt(m.totalRequests);
      $('uCost').textContent = usd(m.totalCost);
      $('uIn').textContent = fmt(m.totalInputTokens);
      $('uOut').textContent = fmt(m.totalOutputTokens);
      // spending limit
      if (m.spendingLimit != null && Number(m.spendingLimit) > 0) {
        const used = Number(m.totalCost) || 0, lim = Number(m.spendingLimit);
        const p = Math.min(100, Math.round(used / lim * 100));
        $('uLimit').textContent = usd(used) + ' / ' + usd(lim) + ' (' + p + '%)';
        $('uBar').style.width = p + '%';
        $('uBar').style.background = p >= 90 ? 'var(--red)' : p >= 70 ? 'var(--yellow)' : 'var(--green)';
        show($('limitRow'), true);
      } else { show($('limitRow'), false); }
      $('uExpiry').textContent = m.expiresAt ? fmtDate(m.expiresAt) : '永久 / 不限';
      // by model
      const wrap = $('byModel');
      wrap.innerHTML = '';
      const list = Array.isArray(m.byModel) ? m.byModel.slice().sort((a,b)=>(b.cost||0)-(a.cost||0)) : [];
      show($('byModelWrap'), list.length > 0);
      for (const mm of list) {
        const div = document.createElement('div');
        div.className = 'mrow';
        const left = document.createElement('div');
        left.innerHTML = '<div class="mname"></div><div class="msub"></div>';
        left.querySelector('.mname').textContent = mm.model;
        left.querySelector('.msub').textContent = fmt(mm.requests) + ' 次 · ' + fmt(mm.inputTokens) + ' in / ' + fmt(mm.outputTokens) + ' out';
        const right = document.createElement('div');
        right.className = 'mcost';
        right.textContent = usd(mm.cost);
        div.appendChild(left); div.appendChild(right);
        wrap.appendChild(div);
      }
    } else if (m.type === 'models') {
      $('modelCount').textContent = (m.count == null ? '--' : m.count);
    } else if (m.type === 'toast') {
      toast(m.level, m.message);
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
