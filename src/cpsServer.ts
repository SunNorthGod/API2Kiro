import * as http from "http";
import { PortHolder, OwnershipListener } from "./portBinder";
import { isEnabled, getRelayMode } from "./config";
import { debug, error, info } from "./log";
import { PROXY_ID_PATH } from "./krsServer";
import {
  fetchRelayModels,
  groupModelsByEffort,
  EFFORT_LEVELS,
  DEFAULT_EFFORT_LEVEL,
} from "./modelStore";
import { getEffortMode } from "./effort";

const PROXY_ID_TOKEN = "api2kiro";

interface CpsModel {
  modelId: string;
  modelName: string;
  description: string;
  promptCaching: {
    maximumCacheCheckpointsPerRequest: number;
    minimumTokensPerCacheCheckpoint: number;
    supportsPromptCaching: boolean;
  };
  rateUnit: string;
  supportedInputTypes: string[];
  tokenLimits: { maxInputTokens: number; maxOutputTokens: number };
  additionalModelRequestFieldsSchema?: unknown;
  defaultEffortLevel?: string;
}

export class CpsProxyServer {
  private holder: PortHolder;
  private port: number;

  constructor(port: number, onOwnershipChange?: OwnershipListener) {
    this.port = port;
    this.holder = new PortHolder(
      port,
      "CPS",
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

  private async buildModelList(): Promise<{ models: CpsModel[]; defaultModel?: { modelId: string } }> {
    const relay = await fetchRelayModels(false);
    const groups = groupModelsByEffort(relay);
    const mode = getEffortMode();
    const official = getRelayMode() === "anthropic";

    const models: CpsModel[] = groups.map((g) => {
      const model: CpsModel = {
        modelId: g.baseId,
        modelName: g.name || g.baseId,
        description: g.description || "",
        promptCaching: {
          maximumCacheCheckpointsPerRequest: 4,
          minimumTokensPerCacheCheckpoint: 1024,
          supportsPromptCaching: true,
        },
        rateUnit: "Credit",
        supportedInputTypes: ["TEXT", "IMAGE"],
        tokenLimits: {
          maxInputTokens: g.maxInputTokens || 200000,
          maxOutputTokens: g.maxOutputTokens || 64000,
        },
      };

      // 决定该模型对外暴露哪些 effort 档位（与 Kiro 官方对齐）：
      // 1) 优先用中转站透出的官方 nativeEffortLevels（各模型不一致，且无 effort 的模型
      //    根本不会带——从而 Kiro 选择器不会给它显示思考档位，彻底对齐官方）。
      // 2) 其次 modelVariant 模式用 -<effort> 后缀变体推断。
      // 3) 最后（通用中转站无 effort 信息时）auto/thinkingBudget 兜底暴露全档位。
      let efforts: string[] = [];
      let schemaPath = "output_config";
      if (official) {
        // 官方 Anthropic 模式：不暴露 Kiro effort/reasoning 档位（sub2api 为纯模型，交给上游默认）
      } else if (g.nativeEffortLevels && g.nativeEffortLevels.length > 0) {
        efforts = g.nativeEffortLevels;
        if (g.effortSchemaPath) {
          schemaPath = g.effortSchemaPath;
        }
      } else if (mode === "modelVariant") {
        efforts = EFFORT_LEVELS.filter((e) => g.efforts.has(e));
      } else if (mode === "auto" || mode === "thinkingBudget") {
        efforts = [...EFFORT_LEVELS];
      }

      if (efforts.length > 0) {
        const defaultEffort =
          g.defaultEffortLevel && efforts.includes(g.defaultEffortLevel)
            ? g.defaultEffortLevel
            : efforts.includes(DEFAULT_EFFORT_LEVEL)
            ? DEFAULT_EFFORT_LEVEL
            : efforts[0];

        if (schemaPath === "reasoning") {
          // GPT 5.6：reasoning.{mode?, effort}，additionalProperties:false（逐字对齐上游真实 schema，
          // 让 Kiro 选择器识别 standard/pro 思考模式）。mode 仅当中转站透出 reasoningModes 时出现。
          const reasoningProps: Record<string, unknown> = {};
          if (g.reasoningModes && g.reasoningModes.length > 0) {
            const defMode =
              g.defaultReasoningMode && g.reasoningModes.includes(g.defaultReasoningMode)
                ? g.defaultReasoningMode
                : g.reasoningModes[0];
            reasoningProps.mode = { type: "string", enum: g.reasoningModes, default: defMode };
          }
          reasoningProps.effort = { type: "string", enum: efforts, default: defaultEffort };
          model.additionalModelRequestFieldsSchema = {
            type: "object",
            properties: { reasoning: { type: "object", properties: reasoningProps } },
            additionalProperties: false,
          };
        } else {
          model.additionalModelRequestFieldsSchema = {
            type: "object",
            properties: {
              [schemaPath]: {
                type: "object",
                properties: {
                  effort: { type: "string", enum: efforts },
                },
              },
            },
          };
        }
        model.defaultEffortLevel = defaultEffort;
      }

      return model;
    });

    const result: { models: CpsModel[]; defaultModel?: { modelId: string } } = { models };
    if (models.length > 0) {
      result.defaultModel = { modelId: models[0].modelId };
    }
    return result;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || "/";
    const path = url.split("?")[0];

    if (path === PROXY_ID_PATH) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ proxy: PROXY_ID_TOKEN, role: "cps" }));
      return;
    }

    if (!isEnabled()) {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }

    const target = (req.headers["x-amz-target"] || req.headers["x-amzn-target"] || "") as string;
    const op = target.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "";
    const pathKey = path.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const contentType = target ? "application/x-amz-json-1.0" : "application/json";

    // Profiles
    if (op === "getprofile" || op === "listavailableprofiles" || pathKey.includes("profile")) {
      req.resume();
      const isList =
        op === "listavailableprofiles" ||
        pathKey.includes("listavailableprofiles") ||
        pathKey.includes("profiles");
      const profile = {
        arn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/API2KIRO",
        profileName: "API2Kiro",
        identityDetails: { region: "us-east-1" },
      };
      res.writeHead(200, { "Content-Type": contentType });
      res.end(JSON.stringify(isList ? { profiles: [profile] } : { profile }));
      return;
    }

    // Model list
    if (op === "listavailablemodels" || pathKey.includes("availablemodels")) {
      req.resume();
      this.buildModelList()
        .then((list) => {
          debug("cps models", { count: list.models.length });
          res.writeHead(200, { "Content-Type": contentType });
          res.end(JSON.stringify(list));
        })
        .catch((e) => {
          error("buildModelList failed:", (e as Error)?.message);
          res.writeHead(200, { "Content-Type": contentType });
          res.end(JSON.stringify({ models: [] }));
        });
      return;
    }

    // Usage limits: we surface usage in our own panel, so return an empty stub
    // (Kiro tolerates an empty object here).
    if (op === "getusagelimits" || pathKey.includes("usagelimit")) {
      req.resume();
      res.writeHead(200, { "Content-Type": contentType });
      res.end(JSON.stringify({}));
      return;
    }

    // Anything else: benign empty object.
    req.resume();
    info("CPS passthrough:", op || pathKey);
    res.writeHead(200, { "Content-Type": contentType });
    res.end("{}");
  }
}
