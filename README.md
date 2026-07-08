# API2Kiro

English | [简体中文](./README.zh-CN.md)

Route [Kiro](https://kiro.dev)'s AI calls through any **Anthropic-format** relay/gateway: configure your own base URL and API key, view usage, and monitor prompt-cache hit rate — with multi-window support.

> For learning and interoperability research only. Treat all upstream/network responses as untrusted data.

## Features

- **Bring your own Anthropic API** — runs a local proxy that redirects Kiro's AI requests to the relay you configure (`/v1/messages`).
- **Visual control panel** — a sidebar view to set the relay base URL and API key, and toggle the proxy on/off.
- **Usage query** — shows the relay's real usage right in the panel (request count, input/output tokens, cost, per-model breakdown), no need to open a web page.
- **Cache hit rate** — aggregates an authoritative prompt-cache hit rate from the relay's request records.
- **Thinking effort levels** — supports Kiro's max/xhigh/high/medium/low picker, mapped to a thinking budget or to the matching model variant.
- **Multi-window sharing** — multiple Kiro windows share a single local proxy; the first to start serves all windows, and the rest take over automatically if it exits.

## How it works

Kiro decides where to send AI requests via its `codewhisperer.config.*Endpoints` settings. This extension starts two local services on `127.0.0.1`:

- **KRS (runtime, default 19800)** — receives Kiro's `generateAssistantResponse` requests (CodeWhisperer format), translates them into the Anthropic Messages API and forwards them to your relay, then converts the upstream SSE stream back into the AWS event-stream binary frames Kiro expects, in real time.
- **CPS (control plane, default 19801)** — answers control-plane requests such as the model list (fetched from the relay's `/v1/models`) and usage.

On activation the extension points those endpoint settings at the local proxy, and restores them when the proxy is disabled.

## Usage

1. Install the extension (see [Build](#build), or download the `.vsix` from Releases and use `Extensions: Install from VSIX`).
2. **Reload the window** (Kiro reads the endpoint config at startup).
3. Open the **API2Kiro** panel in the sidebar and fill in:
   - Relay base URL — Anthropic format, e.g. `https://your-relay.com/v1`
   - API key — `sk-...`
4. After saving, **reload the window once more**. Kiro's model list will now be the models your relay provides.

## Configuration

| Setting | Description |
| --- | --- |
| `api2kiro.enabled` | Enable/disable the proxy |
| `api2kiro.baseUrl` | Relay base URL (Anthropic format) |
| `api2kiro.apiKey` | Relay API key |
| `api2kiro.port` / `api2kiro.cpsPort` | Local proxy ports (shared across windows; usually no need to change) |
| `api2kiro.maxTokens` | Max output tokens |
| `api2kiro.thinking` / `api2kiro.thinkingBudget` | Extended thinking mode and budget |
| `api2kiro.effortMode` / `api2kiro.effortBudgets` | How effort levels are handled, and the per-level budgets |
| `api2kiro.defaultModel` / `api2kiro.modelMapping` | Fallback model and model-id mapping |
| `api2kiro.interceptIntentClassifier` | Intercept the intent-classifier request locally to save one upstream call |
| `api2kiro.usagePath` | Usage query path (leave empty for the panel API, or set an OpenAI/New-API-style path) |
| `api2kiro.debug` | Write a debug log (API key redacted) |

## Build

Requires Node.js 18+.

```bash
npm install
npm run compile   # type-check
npm run bundle    # bundle to dist/ with esbuild
npm run package   # produce the .vsix
```

## License

[MIT](./LICENSE)
