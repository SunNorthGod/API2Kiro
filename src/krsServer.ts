import * as http from "http";
import * as vscode from "vscode";
import { StringDecoder } from "string_decoder";
import { CwRequest, CwEvent } from "./cwTypes";
import { EVENT_STREAM_CONTENT_TYPE, encodeException } from "./eventstream";
import { writeEvent } from "./cwEvents";
import { AnthropicStreamConverter } from "./anthropicStream";
import { buildAnthropicRequest, applyEffort, conversationId, latestModelId, resolveModel } from "./translate";
import { getSelectedEffort, getSelectedMode } from "./effort";
import { isIntentClassifierRequest, buildIntentClassifierResponse } from "./intentClassifier";
import { requestUpstream, readBody } from "./upstream";
import { PortHolder, OwnershipListener } from "./portBinder";
import {
  getApiKey,
  isEnabled,
  getInterceptIntentClassifier,
  resolveApiUrl,
  getBaseUrl,
  getRelayMode,
  getAutoRetry,
  getMaxRetries,
} from "./config";
import { debug, error, info } from "./log";

export const PROXY_ID_PATH = "/__api2kiro_identity";
const PROXY_ID_TOKEN = "api2kiro";

export class KrsProxyServer {
  private holder: PortHolder;
  private port: number;
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext, port: number, onOwnershipChange?: OwnershipListener) {
    this.context = context;
    this.port = port;
    this.holder = new PortHolder(
      port,
      "KRS",
      () => http.createServer((req, res) => this.handleRequest(req, res)),
      onOwnershipChange
    );
  }

  async start(): Promise<void> {
    await this.holder.start();
  }

  async stop(): Promise<void> {
    await this.holder.stop();
  }

  isOwner(): boolean {
    return this.holder.isOwner();
  }

  hadForeignConflict(): boolean {
    return this.holder.hadForeignConflict();
  }

  getPort(): number {
    return this.port;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || "/";
    const method = req.method || "GET";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (url.split("?")[0] === PROXY_ID_PATH) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proxy: PROXY_ID_TOKEN, role: "krs" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      try {
        if (!isEnabled()) {
          // Proxy disabled: shouldn't normally be reachable, but be safe.
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
          return;
        }
        const path = url.split("?")[0];
        const isGenerate =
          path === "/generateAssistantResponse" ||
          path === "/SendMessageStreaming" ||
          (method === "POST" && body.indexOf("conversationState") !== -1);

        if (isGenerate) {
          await this.handleGenerate(res, body);
        } else if (method === "POST" && this.looksLikeJsonRpc(body)) {
          // Kiro 的 InvokeMCPCommand（服务端 MCP 工具发现）走的是流式客户端端点，
          // 会被路由到这里。本地就地应答一个合法的 JSON-RPC 结果。
          this.handleMcpJsonRpc(res, body);
        } else {
          info("KRS unhandled:", method, path);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        }
      } catch (e) {
        error("KRS error:", (e as Error).message);
        if (!res.headersSent) {
          res.writeHead(500, {
            "Content-Type": "application/json",
            "x-amzn-errortype": "InternalServerException",
          });
        }
        res.end(JSON.stringify({ __type: "InternalServerException", message: (e as Error).message }));
      }
    });
  }

  /** Heuristic: Kiro's InvokeMCPCommand body is JSON-RPC ({"jsonrpc","method",...}). */
  private looksLikeJsonRpc(body: string): boolean {
    return body.indexOf('"jsonrpc"') !== -1 && body.indexOf('"method"') !== -1;
  }

  /**
   * Answer Kiro's server-side MCP discovery (InvokeMCPCommand) locally.
   *
   * Kiro routes CodeWhisperer streaming-client commands (including InvokeMCPCommand)
   * to the runtime endpoint, which this proxy now owns. Against a real AWS backend
   * that call returns the backend's hosted MCP tools; against a third-party relay
   * there are none. Returning `{}` is invalid JSON-RPC and makes Kiro's
   * RemoteToolsDiscovery fail (the agent then looks like it has no tools). Kiro's
   * file/terminal capabilities are client-side (ACP) and unaffected, so we reply
   * with a *valid* JSON-RPC result advertising no remote tools — discovery then
   * succeeds cleanly and the local tools remain available.
   */
  private handleMcpJsonRpc(res: http.ServerResponse, rawBody: string): void {
    let id: unknown = null;
    let rpcMethod = "";
    try {
      const parsed = JSON.parse(rawBody);
      id = parsed?.id ?? null;
      rpcMethod = typeof parsed?.method === "string" ? parsed.method : "";
    } catch {
      /* fall through to a generic empty result */
    }

    info("KRS MCP:", rpcMethod || "(unparsed)");

    // JSON-RPC notifications carry no id and expect no response body.
    if (id === null || id === undefined) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("");
      return;
    }

    const version = this.context.extension.packageJSON.version || "0.0.0";
    let result: unknown;
    switch (rpcMethod) {
      case "initialize":
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "api2kiro", version },
        };
        break;
      case "tools/list":
        result = { tools: [] };
        break;
      case "prompts/list":
        result = { prompts: [] };
        break;
      case "resources/list":
        result = { resources: [] };
        break;
      case "resources/templates/list":
        result = { resourceTemplates: [] };
        break;
      default:
        result = {};
        break;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private beginEventStream(res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": EVENT_STREAM_CONTENT_TYPE,
      "Transfer-Encoding": "chunked",
    });
    try {
      res.socket?.setNoDelay(true);
    } catch {
      /* ignore */
    }
  }

  /** Emit a friendly setup message as a normal assistant reply. */
  private writeSetupMessage(res: http.ServerResponse, convId: string, msg: string): void {
    this.beginEventStream(res);
    writeEvent(res, { messageMetadataEvent: { conversationId: convId } });
    writeEvent(res, { assistantResponseEvent: { content: msg, modelId: "api2kiro-setup" } });
    res.end();
  }

  private async handleGenerate(res: http.ServerResponse, rawBody: string): Promise<void> {
    let parsed: CwRequest;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }

    const convId = conversationId(parsed);
    const kiroModel = latestModelId(parsed);

    const baseUrl = getBaseUrl();
    const apiKey = getApiKey();
    if (!baseUrl || !apiKey) {
      this.writeSetupMessage(
        res,
        convId,
        "⚠️ API2Kiro 尚未配置完成。\n\n请在左侧 “API2Kiro” 控制面板中填写中转站地址与 API Key 后再试。\n\n" +
          (baseUrl ? "" : "· 缺少中转站地址\n") +
          (apiKey ? "" : "· 缺少 API Key\n")
      );
      return;
    }

    // Intercept Kiro's intent classifier locally to save an upstream call.
    if (getInterceptIntentClassifier() && isIntentClassifierRequest(parsed)) {
      debug("intent classifier intercepted", { conversationId: convId });
      this.beginEventStream(res);
      for (const ev of buildIntentClassifierResponse(parsed, convId, kiroModel)) {
        writeEvent(res, ev);
      }
      res.end();
      return;
    }

    const official = getRelayMode() === "anthropic";
    const anthropicBody = buildAnthropicRequest(parsed);
    let effortInfo = "";
    if (official) {
      // 官方 Anthropic 模式：纯透传，剥掉 Kiro 私有 / 思考字段（output_config 私有；thinking 交给上游默认）
      delete anthropicBody.thinking;
      delete anthropicBody.output_config;
    } else {
      const effort = await getSelectedEffort(parsed);
      const reasoningMode = getSelectedMode(parsed);
      applyEffort(anthropicBody, effort, reasoningMode);
      effortInfo = `${effort ? ", effort=" + effort : ""}${reasoningMode ? ", mode=" + reasoningMode : ""}`;
    }
    const upstreamModel = anthropicBody.model;
    const targetUrl = resolveApiUrl("/messages");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      Accept: "text/event-stream",
      "X-Client": "api2kiro/" + (this.context.extension.packageJSON.version || "0.0.0"),
    };
    if (official) {
      // sub2api 等官方兼容网关通常认 Authorization: Bearer（同时保留 x-api-key 双保险）
      headers["Authorization"] = "Bearer " + apiKey;
    }

    info(
      `→ /messages [${official ? "official" : "kiro"}] model=${upstreamModel} (kiro=${kiroModel}${effortInfo}) conv=${convId}`
    );
    debug("upstream request", { url: targetUrl, body: anthropicBody });

    await this.streamWithRetry(
      res,
      targetUrl,
      headers,
      JSON.stringify(anthropicBody),
      convId,
      upstreamModel
    );
  }

  /**
   * 发起上游请求并流式转换回 Kiro；在「尚未向客户端吐出任何内容」时对连接失败 /
   * 可重试状态码(5xx/429) / 流中途中断透明重试。一旦已开始向客户端输出正文/思考/工具
   * (committed)，则不再重试(避免重复内容)，尽力收尾。
   */
  private async streamWithRetry(
    res: http.ServerResponse,
    targetUrl: string,
    headers: Record<string, string>,
    bodyStr: string,
    convId: string,
    modelId: string
  ): Promise<void> {
    const maxAttempts = getAutoRetry() ? getMaxRetries() + 1 : 1;
    let lastReason = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const backoff = Math.min(300 * (attempt - 1), 1500);
        info(`↻ 自动重试 ${attempt}/${maxAttempts} (${backoff}ms后) conv=${convId} 原因=${lastReason}`);
        await new Promise((r) => setTimeout(r, backoff));
      }

      // 1) 发起上游请求（连接失败可重试）
      let upstream;
      try {
        upstream = await requestUpstream("POST", targetUrl, headers, bodyStr);
      } catch (e) {
        lastReason = "连接失败: " + (e as Error).message;
        error("upstream fetch failed:", (e as Error).message);
        if (attempt < maxAttempts) {
          continue;
        }
        res.writeHead(502, {
          "Content-Type": "application/json",
          "x-amzn-errortype": "InternalServerException",
        });
        res.end(
          JSON.stringify({
            __type: "InternalServerException",
            message: "无法连接中转站：" + (e as Error).message,
          })
        );
        return;
      }

      // 2) 非 2xx：5xx/429 可重试；其余(4xx)直接透传给客户端
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        const errText = await readBody(upstream.body);
        error(`upstream ${upstream.statusCode}:`, errText.slice(0, 300));
        const retryable = upstream.statusCode >= 500 || upstream.statusCode === 429;
        if (retryable && attempt < maxAttempts) {
          lastReason = `上游 ${upstream.statusCode}`;
          continue;
        }
        this.beginEventStream(res);
        writeEvent(res, { messageMetadataEvent: { conversationId: convId } });
        writeEvent(res, {
          assistantResponseEvent: {
            content: `❌ 上游返回 ${upstream.statusCode}：\n\n${errText.slice(0, 800)}`,
            modelId,
          },
        });
        res.write(encodeException("InternalServerException", { message: `Upstream ${upstream.statusCode}` }));
        res.end();
        return;
      }

      // 3) 2xx：流式转换（内部缓冲，首个内容事件前不落客户端）
      const r = await this.pumpStream(res, upstream.body, convId, modelId);
      if (r.clientClosed) {
        return; // 客户端已断开
      }
      if (r.committed) {
        return; // 已向客户端输出内容(完整或部分)，pumpStream 已收尾
      }
      // 未 committed：客户端还没收到任何内容 → 流在吐正文前就断了/空响应，可重试
      lastReason = "流在输出内容前中断";
      if (attempt < maxAttempts) {
        continue;
      }
      // 重试用尽仍未拿到内容 → 给客户端一个干净的错误
      this.beginEventStream(res);
      writeEvent(res, { messageMetadataEvent: { conversationId: convId } });
      writeEvent(res, {
        assistantResponseEvent: {
          content: "❌ 与中转站的连接多次中断，未能获取回复，请重试。",
          modelId,
        },
      });
      res.write(encodeException("InternalServerException", { message: "upstream interrupted after retries" }));
      res.end();
      return;
    }
  }

  /**
   * Read the Anthropic SSE stream, convert each event, and write to Kiro.
   *
   * 关键：首个「内容事件」(assistantResponseEvent 正文 / reasoningContentEvent 思考 /
   * toolUseEvent) 到达前，把事件(如 messageMetadataEvent)缓冲、不写客户端，也不发响应头
   * (beginEventStream 延迟到 commit)。这样若流在吐出内容前中断，客户端毫无察觉，可由
   * streamWithRetry 透明重发。返回:
   *   - committed: 是否已向客户端提交(发过响应头/写过事件)
   *   - ok:        是否正常完成(收到内容并自然结束)
   *   - clientClosed: 客户端是否中途断开
   */
  private pumpStream(
    res: http.ServerResponse,
    body: http.IncomingMessage,
    convId: string,
    modelId: string
  ): Promise<{ committed: boolean; ok: boolean; clientClosed: boolean }> {
    return new Promise((resolve) => {
      const converter = new AnthropicStreamConverter(convId, modelId);
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let clientClosed = false;
      let finished = false;
      let committed = false;
      const pending: CwEvent[] = [];

      const isContentEvent = (ev: CwEvent): boolean =>
        !!(
          (ev.assistantResponseEvent && ev.assistantResponseEvent.content) ||
          ev.reasoningContentEvent ||
          ev.toolUseEvent
        );

      const commit = () => {
        if (committed) {
          return;
        }
        committed = true;
        this.beginEventStream(res);
        for (const ev of pending) {
          writeEvent(res, ev);
        }
        pending.length = 0;
      };

      const emit = (ev: CwEvent) => {
        if (committed) {
          writeEvent(res, ev);
          return;
        }
        pending.push(ev);
        if (isContentEvent(ev)) {
          commit();
        }
      };

      const settle = (ok: boolean) => {
        if (finished) {
          return;
        }
        finished = true;
        res.removeListener("close", onClientClose);
        resolve({ committed, ok, clientClosed });
      };

      const onClientClose = () => {
        clientClosed = true;
        try {
          body.destroy();
        } catch {
          /* ignore */
        }
        settle(false);
      };
      res.on("close", onClientClose);

      const processBuffer = () => {
        // SSE events are separated by blank lines; process complete lines.
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (!line) {
            continue;
          }
          const events = converter.processLine(line);
          for (const ev of events) {
            if (clientClosed) {
              return;
            }
            emit(ev);
          }
        }
      };

      const finalizeCommitted = () => {
        try {
          for (const ev of converter.flush()) {
            writeEvent(res, ev);
          }
          if (!res.writableEnded) {
            res.end();
          }
        } catch {
          /* ignore */
        }
        debug("upstream usage", converter.usage);
      };

      body.on("data", (chunk: Buffer) => {
        if (clientClosed) {
          return;
        }
        buffer += decoder.write(chunk);
        try {
          processBuffer();
        } catch (e) {
          error("stream process error:", (e as Error).message);
        }
      });

      body.on("end", () => {
        buffer += decoder.end();
        try {
          processBuffer();
        } catch {
          /* ignore */
        }
        if (clientClosed) {
          return;
        }
        if (committed) {
          finalizeCommitted();
          settle(true);
        } else {
          // 整条流结束却没吐出任何内容 → 视为失败(可重试)，不碰 res
          settle(false);
        }
      });

      body.on("error", (e) => {
        error("upstream stream error:", (e as Error).message);
        if (clientClosed) {
          return;
        }
        if (committed) {
          // 已向客户端输出部分内容，无法重试；尽力收尾
          finalizeCommitted();
          settle(false);
        } else {
          // 尚未向客户端输出 → 可重试，保持 res 原样
          settle(false);
        }
      });
    });
  }
}

// Re-export for the CPS server / others that resolve upstream model ids.
export { resolveModel };
