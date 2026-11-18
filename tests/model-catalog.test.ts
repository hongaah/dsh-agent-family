import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FamilyHub } from "../src/core/family-hub.ts";
import { MemberRegistry } from "../src/core/member-registry.ts";
import { ModelCatalogService } from "../src/core/model-catalog.ts";
import type { BodySpec, MemberStreamEvent } from "../src/core/types.ts";
import {
  AsyncEventQueue,
  type AwakenMemberContext,
  type BodyDriver,
  type LiveMemberSession,
} from "../src/drivers/driver.ts";

function writeExec(dir: string, name: string, body: string): string {
  const filePath = join(dir, name);
  writeFileSync(filePath, `#!${process.execPath}\n${body}\n`, "utf8");
  chmodSync(filePath, 0o755);
  return filePath;
}

describe("ModelCatalogService & Live Per-Member Model/Effort Switching", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dsh-family-models-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("discovers models across codex, claude, opencode, and dsh cleanly", async () => {
    const mockCodex = writeExec(
      tempDir,
      "codex",
      `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ id: msg.id, result: { userAgent: 'mock' } }) + '\\n');
        } else if (msg.method === 'model/list') {
          process.stdout.write(JSON.stringify({
            id: msg.id,
            result: {
              data: [
                {
                  id: 'auto/gpt-5.4-mini',
                  model: 'auto/gpt-5.4-mini',
                  displayName: 'GPT-5.4 Mini',
                  isDefault: true,
                  hidden: false,
                  supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }]
                },
                {
                  id: 'hidden/internal',
                  model: 'hidden/internal',
                  displayName: 'Internal',
                  isDefault: false,
                  hidden: true,
                  supportedReasoningEfforts: []
                }
              ]
            }
          }) + '\\n');
        }
      });
      `,
    );

    const mockOpenCode = writeExec(
      tempDir,
      "opencode",
      `
      if (process.argv[2] === 'models') {
        process.stdout.write('opencode/deepseek-v4.1-flash-free\\ngitlab/duo-chat-gpt-5-4-mini\\n');
        process.exit(0);
      }
      `,
    );

    const claudeSettingsFile = join(tempDir, "claude-settings.json");
    writeFileSync(
      claudeSettingsFile,
      JSON.stringify({
        model: "team-router/claude-opus-5-5[1m]",
        env: {
          ANTHROPIC_AUTH_TOKEN: "super-secret-never-leak",
          CLAUDE_CODE_MODEL_CAPABILITIES:
            "auto/claude-haiku-5-5=effort;auto/claude-sonnet-5-5=effort,max_effort",
        },
      }),
      "utf8",
    );

    const catalog = new ModelCatalogService({
      locatorOptions: {
        extraSearchDirs: [tempDir],
        includeSystemPaths: false,
      },
      claudeSettingsPath: claudeSettingsFile,
      dshCatalogProvider: async () => ({
        currentDefault: "deepseek-account/deepseek-chat",
        models: [
          {
            id: "deepseek-account/deepseek-chat",
            label: "DeepSeek Chat (极速日常)",
            isDefault: true,
            supportedEfforts: ["low", "medium", "high"],
          },
          {
            id: "deepseek-account/deepseek-reasoner",
            label: "DeepSeek Reasoner (深度推理)",
            supportedEfforts: ["low", "medium", "high"],
          },
        ],
      }),
    });

    const codexCat = await catalog.getCatalog("codex");
    expect(codexCat.currentDefault).toBe("auto/gpt-5.4-mini");
    expect(codexCat.models.map((m) => m.id)).toEqual(["auto/gpt-5.4-mini"]);
    expect(codexCat.models[0]?.supportedEfforts).toEqual(["low", "medium"]);
    expect(mockCodex).toBeTruthy();

    const claudeCat = await catalog.getCatalog("claude");
    expect(claudeCat.currentDefault).toBe("team-router/claude-opus-5-5[1m]");
    const claudeIds = claudeCat.models.map((m) => m.id);
    expect(claudeIds).toContain("auto/claude-haiku-5-5");
    expect(claudeIds).toContain("haiku");
    expect(JSON.stringify(claudeCat)).not.toContain("super-secret-never-leak");

    const ocCat = await catalog.getCatalog("opencode");
    expect(ocCat.models.map((m) => m.id)).toContain(
      "opencode/deepseek-v4.1-flash-free",
    );
    expect(mockOpenCode).toBeTruthy();

    const dshCat = await catalog.getCatalog("dsh");
    expect(dshCat.currentDefault).toBe("deepseek-account/deepseek-chat");
    expect(dshCat.models).toHaveLength(2);
  });

  it("persists member model & reasoningEffort and hot-reconfigures active sessions without losing memory", async () => {
    const registry = new MemberRegistry(tempDir);
    registry.create({
      id: "fe-codex",
      name: "小前端",
      specialty: "前端快手",
      body: {
        kind: "codex",
        model: "auto/gpt-5.4",
        reasoningEffort: "high",
      },
      soulPrompt: "幽默快手",
    });

    let awakenCount = 0;
    const hotDriver: BodyDriver = {
      kind: "codex",
      awaken: async (ctx: AwakenMemberContext): Promise<LiveMemberSession> => {
        awakenCount += 1;
        let currentSpec: BodySpec = ctx.member.body;
        return {
          bodyKind: "codex",
          isAlive: () => true,
          reconfigure: async (nextSpec: BodySpec): Promise<boolean> => {
            currentSpec = nextSpec;
            return true;
          },
          sendTurn: (prompt: string): AsyncIterable<MemberStreamEvent> => {
            const q = new AsyncEventQueue<MemberStreamEvent>();
            const text = `唤醒#${awakenCount}|模型=${currentSpec.model ?? "default"}|档位=${currentSpec.reasoningEffort ?? "default"}:${prompt}`;
            q.push({ kind: "text_delta", delta: text });
            q.push({ kind: "turn_done", finalText: text });
            q.close();
            return q;
          },
          replyApproval: async () => undefined,
          dispose: async () => undefined,
        };
      },
    };

    const hub = new FamilyHub({
      registry,
      drivers: [hotDriver],
      storageDir: tempDir,
    });

    const r1 = await hub.sendMemberMessage({
      scopeId: "s1",
      memberId: "fe-codex",
      senderRole: "human",
      senderName: "你",
      message: "第一句",
      cwd: tempDir,
    });
    expect(r1.finalText).toBe("唤醒#1|模型=auto/gpt-5.4|档位=high:第一句");

    // 在线热切换为极速模型 + low 档位
    registry.update("fe-codex", {
      body: {
        kind: "codex",
        model: "auto/gpt-5.4-mini",
        reasoningEffort: "low",
      },
    });
    // 等待异步订阅热更新生效
    await new Promise((r) => setTimeout(r, 15));

    const r2 = await hub.sendMemberMessage({
      scopeId: "s1",
      memberId: "fe-codex",
      senderRole: "human",
      senderName: "你",
      message: "第二句秒回",
      cwd: tempDir,
    });
    // 验证未重新唤醒进程（记忆保留），但模型和档位已即时生效！
    expect(r2.finalText).toBe(
      "唤醒#1|模型=auto/gpt-5.4-mini|档位=low:第二句秒回",
    );

    await hub.dispose();
  });
});
