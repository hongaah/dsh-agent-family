import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildChildProcessEnv, type LocatorOptions, resolveBodyExecutable } from './cli-locator.ts';
import type { BodyKind, BodyModelCatalog, BodyModelOption } from './types.ts';
import { JsonRpcStdioPeer } from '../drivers/json-rpc-peer.ts';

const CACHE_TTL_MS = 5 * 60 * 1000;

function isLikelyFastModel(id: string, label: string = ''): boolean {
  const combined = `${id} ${label}`.toLowerCase();
  return (
    combined.includes('flash') ||
    combined.includes('mini') ||
    combined.includes('haiku') ||
    combined.includes('lite') ||
    combined.includes('spark') ||
    combined.includes('lightning')
  );
}

export interface DshHostModelCatalogSnapshot {
  readonly currentDefault?: string;
  readonly models: readonly BodyModelOption[];
}

export interface ModelCatalogServiceOptions {
  readonly locatorOptions?: LocatorOptions;
  readonly claudeSettingsPath?: string;
  readonly dshCatalogProvider?: () => Promise<DshHostModelCatalogSnapshot>;
}

/**
 * 按 CLI 身体类型动态发现本机真实可用模型与推理强度档位（不修改任何 CLI 内部配置）。
 * 内置 5 分钟内存缓存并支持一键刷新。
 */
export class ModelCatalogService {
  private readonly locatorOptions?: LocatorOptions;
  private readonly claudeSettingsPath: string;
  private readonly dshCatalogProvider?: () => Promise<DshHostModelCatalogSnapshot>;
  private readonly cache = new Map<BodyKind, { expiresAt: number; catalog: BodyModelCatalog }>();

  public constructor(options: ModelCatalogServiceOptions = {}) {
    this.locatorOptions = options.locatorOptions;
    this.claudeSettingsPath =
      options.claudeSettingsPath ?? join(homedir(), '.claude', 'settings.json');
    this.dshCatalogProvider = options.dshCatalogProvider;
  }

  public async getCatalog(kind: BodyKind, forceRefresh: boolean = false): Promise<BodyModelCatalog> {
    const now = Date.now();
    const cached = this.cache.get(kind);
    if (!forceRefresh && cached && cached.expiresAt > now) {
      return cached.catalog;
    }

    let catalog: BodyModelCatalog;
    switch (kind) {
      case 'codex':
        catalog = await this.discoverCodexModels();
        break;
      case 'claude':
        catalog = this.discoverClaudeModels();
        break;
      case 'opencode':
        catalog = await this.discoverOpenCodeModels();
        break;
      case 'dsh':
        catalog = await this.discoverDshModels();
        break;
    }

    this.cache.set(kind, {
      expiresAt: now + CACHE_TTL_MS,
      catalog,
    });
    return catalog;
  }

  private async discoverCodexModels(): Promise<BodyModelCatalog> {
    const executable = await resolveBodyExecutable({ kind: 'codex' }, this.locatorOptions);
    if (!executable) {
      return {
        kind: 'codex',
        models: [],
        supportsEffort: true,
        defaultEfforts: ['low', 'medium', 'high', 'xhigh'],
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const peer = new JsonRpcStdioPeer({
      executable,
      args: ['app-server', '--stdio'],
      cwd: process.cwd(),
      includeJsonRpcHeader: false,
      onNotification: () => undefined,
      onServerRequest: ({ id }) => peer.respond(id, {}),
      onExit: () => undefined,
    });

    try {
      await peer.request(
        'initialize',
        {
          clientInfo: { name: 'dsh-agent-family-probe', title: 'Probe', version: '0.1.0' },
          capabilities: null,
        },
        controller.signal
      );
      peer.notify('initialized', {});
      const res = await peer.request('model/list', {}, controller.signal);
      const rawData = Array.isArray(res.data) ? res.data : [];

      let currentDefault: string | undefined;
      const models: BodyModelOption[] = [];
      const seen = new Set<string>();

      for (const rawItem of rawData) {
        if (!rawItem || typeof rawItem !== 'object') continue;
        const item = rawItem as Record<string, unknown>;
        if (item.hidden === true) continue;
        const id =
          typeof item.model === 'string' && item.model.trim()
            ? item.model.trim()
            : typeof item.id === 'string'
              ? item.id.trim()
              : '';
        if (!id || seen.has(id)) continue;
        seen.add(id);

        const displayName =
          typeof item.displayName === 'string' && item.displayName.trim()
            ? item.displayName.trim()
            : id;
        const isDefault = item.isDefault === true;
        if (isDefault && !currentDefault) {
          currentDefault = id;
        }

        const rawEfforts = Array.isArray(item.supportedReasoningEfforts)
          ? item.supportedReasoningEfforts
          : [];
        const supportedEfforts: string[] = [];
        for (const e of rawEfforts) {
          if (e && typeof e === 'object') {
            const val = (e as Record<string, unknown>).reasoningEffort;
            if (typeof val === 'string' && !supportedEfforts.includes(val)) {
              supportedEfforts.push(val);
            }
          }
        }

        models.push({
          id,
          label: displayName,
          isDefault,
          isFast: isLikelyFastModel(id, displayName),
          ...(supportedEfforts.length > 0 ? { supportedEfforts } : {}),
        });
      }

      return {
        kind: 'codex',
        ...(currentDefault ? { currentDefault } : {}),
        models,
        supportsEffort: true,
        defaultEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      };
    } catch {
      return {
        kind: 'codex',
        models: [],
        supportsEffort: true,
        defaultEfforts: ['low', 'medium', 'high', 'xhigh'],
      };
    } finally {
      clearTimeout(timer);
      await peer.dispose().catch(() => undefined);
    }
  }

  private discoverClaudeModels(): BodyModelCatalog {
    let currentDefault: string | undefined;
    const models: BodyModelOption[] = [];
    const seen = new Set<string>();

    const pushModel = (opt: BodyModelOption) => {
      if (!opt.id || seen.has(opt.id)) return;
      seen.add(opt.id);
      models.push(opt);
    };

    // 1. 先提供官方标准快捷别名（适配所有 Anthropic / 代理配置）
    pushModel({
      id: 'haiku',
      label: 'Claude Haiku (极速秒回 · 闲聊与轻量修改推荐)',
      isFast: true,
      supportedEfforts: ['low', 'medium', 'high'],
    });
    pushModel({
      id: 'sonnet',
      label: 'Claude Sonnet (均衡主力 · 日常编码推荐)',
      supportedEfforts: ['low', 'medium', 'high', 'max'],
    });
    pushModel({
      id: 'opus',
      label: 'Claude Opus (旗舰深度 · 复杂架构把关)',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    pushModel({
      id: 'fable',
      label: 'Claude Fable (代理映射别名)',
      supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });

    // 2. 安全读取 ~/.claude/settings.json 中公开声明的模型字段与能力映射（绝不读取任何密钥字段）
    if (existsSync(this.claudeSettingsPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.claudeSettingsPath, 'utf8')) as Record<
          string,
          unknown
        >;
        if (typeof parsed.model === 'string' && parsed.model.trim()) {
          currentDefault = parsed.model.trim();
          pushModel({
            id: currentDefault,
            label: `${currentDefault} (当前默认)`,
            isDefault: true,
            isFast: isLikelyFastModel(currentDefault),
            supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          });
        }

        const envObj =
          parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
            ? (parsed.env as Record<string, unknown>)
            : {};

        for (const envKey of [
          'ANTHROPIC_SMALL_FAST_MODEL',
          'ANTHROPIC_DEFAULT_HAIKU_MODEL',
          'ANTHROPIC_DEFAULT_SONNET_MODEL',
          'ANTHROPIC_DEFAULT_OPUS_MODEL',
          'ANTHROPIC_DEFAULT_FABLE_MODEL',
        ]) {
          const val = envObj[envKey];
          if (typeof val === 'string' && val.trim()) {
            const cleanId = val.trim();
            pushModel({
              id: cleanId,
              label: cleanId,
              isFast: isLikelyFastModel(cleanId, envKey),
              supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            });
          }
        }

        const capStr = envObj.CLAUDE_CODE_MODEL_CAPABILITIES;
        if (typeof capStr === 'string' && capStr.trim()) {
          for (const segment of capStr.split(';')) {
            const [rawModelId, rawCaps] = segment.split('=');
            const modelId = rawModelId?.trim() ?? '';
            if (!modelId) continue;
            const caps = (rawCaps ?? '').split(',').map((s) => s.trim());
            const efforts = ['low', 'medium', 'high'];
            if (caps.includes('xhigh_effort')) efforts.push('xhigh');
            if (caps.includes('max_effort')) efforts.push('max');
            pushModel({
              id: modelId,
              label: modelId,
              isFast: isLikelyFastModel(modelId),
              supportedEfforts: efforts,
            });
          }
        }
      } catch {
        // ignore malformed settings.json
      }
    }

    return {
      kind: 'claude',
      ...(currentDefault ? { currentDefault } : {}),
      models,
      supportsEffort: true,
      defaultEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    };
  }

  private async discoverOpenCodeModels(): Promise<BodyModelCatalog> {
    const executable = await resolveBodyExecutable({ kind: 'opencode' }, this.locatorOptions);
    if (!executable) {
      return {
        kind: 'opencode',
        models: [],
        supportsEffort: false,
        defaultEfforts: [],
      };
    }

    const stdout = await new Promise<string>((resolveOut) => {
      execFile(
        executable,
        ['models'],
        {
          env: buildChildProcessEnv({}, executable),
          timeout: 4000,
          maxBuffer: 1024 * 1024,
        },
        (err, out) => {
          resolveOut(err ? '' : out);
        }
      );
    });

    const models: BodyModelOption[] = [];
    const seen = new Set<string>();
    for (const rawLine of stdout.split(/\r?\n/u)) {
      const id = rawLine.trim();
      if (!id || !id.includes('/') || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        label: id,
        isFast: isLikelyFastModel(id),
      });
    }

    return {
      kind: 'opencode',
      models,
      supportsEffort: false,
      defaultEfforts: [],
    };
  }

  private async discoverDshModels(): Promise<BodyModelCatalog> {
    if (this.dshCatalogProvider) {
      try {
        const snap = await this.dshCatalogProvider();
        return {
          kind: 'dsh',
          ...(snap.currentDefault ? { currentDefault: snap.currentDefault } : {}),
          models: snap.models.map((m) => ({
            ...m,
            isFast: m.isFast ?? isLikelyFastModel(m.id, m.label),
          })),
          supportsEffort: true,
          defaultEfforts: ['low', 'medium', 'high'],
        };
      } catch {
        // fallback below
      }
    }

    return {
      kind: 'dsh',
      models: [
        {
          id: 'deepseek-chat',
          label: 'DeepSeek Chat (极速对话与日常推荐)',
          isFast: true,
          supportedEfforts: ['low', 'medium', 'high'],
        },
        {
          id: 'deepseek-reasoner',
          label: 'DeepSeek Reasoner (深度思考)',
          supportedEfforts: ['low', 'medium', 'high'],
        },
      ],
      supportsEffort: true,
      defaultEfforts: ['low', 'medium', 'high'],
    };
  }
}
