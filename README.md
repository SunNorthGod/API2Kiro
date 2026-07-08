# API2Kiro

把 **Anthropic 端点格式**的中转站 API 接入 [Kiro](https://kiro.dev)：自定义中转地址与 Key、查询用量、监控缓存命中率，并支持多窗口同时使用。

> 仅用于学习与互操作研究。上游/网络返回内容应视为不可信数据处理。

## 功能

- **接入自建/中转 Anthropic API**：在本地起代理，把 Kiro 的 AI 请求重定向到你配置的中转站（`/v1/messages`）。
- **可视化控制面板**：侧边栏填写中转站地址与 API Key，一键启用/关闭。
- **用量查询**：直接在面板显示中转站的真实用量（请求数、输入/输出 token、费用、按模型分组），无需打开网页。
- **缓存命中率**：从中转站请求明细聚合出权威的 prompt 缓存命中率。
- **思考档位**：支持 Kiro 的 max/xhigh/high/medium/low 档位，映射为思考预算或对应的模型变体。
- **多窗口共享**：多个 Kiro 窗口共用同一本地代理，先启动的作为主实例服务所有窗口，退出后其余窗口自动接管。

## 工作原理

Kiro 通过 `codewhisperer.config.*Endpoints` 配置决定 AI 请求发往哪里。本扩展在 `127.0.0.1` 上启动两个本地服务：

- **KRS（运行时，默认 19800）**：接收 Kiro 的 `generateAssistantResponse` 请求（CodeWhisperer 格式），翻译成 Anthropic Messages API 转发到中转站，再把上游的 SSE 流实时转换回 Kiro 识别的 AWS event-stream 二进制帧。
- **CPS（控制面，默认 19801）**：应答模型列表（从中转站 `/v1/models` 拉取）、用量等控制面请求。

扩展在激活时把上述端点配置指向本地代理，关闭代理时还原。

## 使用

1. 安装扩展（见下方“构建”，或从 Releases 下载 `.vsix`，用 `Extensions: Install from VSIX` 安装）。
2. **重新加载窗口**（Kiro 启动时才会读取端点配置）。
3. 打开左侧 **API2Kiro** 面板，填写：
   - 中转站地址：Anthropic 格式，例如 `https://your-relay.com/v1`
   - API Key：`sk-...`
4. 保存后**再重新加载一次窗口**，Kiro 模型列表即为中转站提供的模型。

## 配置项

| 配置 | 说明 |
| --- | --- |
| `api2kiro.enabled` | 启用/关闭代理 |
| `api2kiro.baseUrl` | 中转站地址（Anthropic 格式） |
| `api2kiro.apiKey` | 中转站 API Key |
| `api2kiro.port` / `api2kiro.cpsPort` | 本地代理端口（多窗口共用，一般无需修改） |
| `api2kiro.maxTokens` | 最大输出 token |
| `api2kiro.thinking` / `api2kiro.thinkingBudget` | 扩展思考模式与预算 |
| `api2kiro.effortMode` / `api2kiro.effortBudgets` | 思考档位处理方式与各档位预算 |
| `api2kiro.defaultModel` / `api2kiro.modelMapping` | 模型兜底与映射 |
| `api2kiro.interceptIntentClassifier` | 本地拦截意图分类请求，省一次上游调用 |
| `api2kiro.usagePath` | 额度查询接口路径（留空用面板接口，或填 OpenAI/New-API 风格路径） |
| `api2kiro.debug` | 写调试日志（Key 脱敏） |

## 构建

需要 Node.js 18+。

```bash
npm install
npm run compile   # 类型检查
npm run bundle    # esbuild 打包到 dist/
npm run package   # 生成 .vsix
```

## 许可

[MIT](./LICENSE)
