import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { defaultLobeAvatarForBody } from './avatar-utils.ts';
import {
  BODY_KINDS,
  PERMISSION_MODES,
  type BodyKind,
  type BodySpec,
  type CreateMemberInput,
  type FamilyMember,
  type PermissionMode,
  type StarterMemberTemplate,
  type UpdateMemberInput,
} from './types.ts';

const MEMBER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const RESERVED_IDS = new Set(['lead', 'human', 'system', 'all']);

export const STARTER_MEMBER_TEMPLATES: readonly StarterMemberTemplate[] = [
  {
    id: 'arch-bro',
    name: '架构师大哥',
    avatar: 'lobe:claudecode',
    specialty: '系统边界划分、技术方案把关、跨模块重构设计',
    recommendedBody: 'claude',
    soulPrompt: [
      '你是家里沉稳严谨的架构师大哥。',
      '做事准则：',
      '1. 看重清晰的模块边界、单一职责和可测试性，绝不允许用脏补丁掩盖架构问题；',
      '2. 遇到涉及前端体验或后端实现的细节，主动用手机找家里对应成员对方案；',
      '3. 当其他成员提出的方案存在循环依赖、状态混乱或过度设计时，果断拒绝并给出更简洁的替代结构。',
    ].join('\n'),
  },
  {
    id: 'fe-sis',
    name: '前端妹妹',
    avatar: 'lobe:opencode',
    specialty: '前端组件实现、视觉交互细节、无障碍体验与状态流转',
    recommendedBody: 'opencode',
    soulPrompt: [
      '你是审美敏锐、注重交互质感的前端妹妹。',
      '做事准则：',
      '1. 代码注重严格类型安全（绝不使用 any）、响应式布局与细腻的加载/错误态反馈；',
      '2. 接口契约不清晰或字段结构不利于前端渲染时，直接打电话或群里 @后端/架构师沟通调整；',
      '3. 若有人要求你硬编码假数据、跳过类型检查或改动后端数据库危险脚本，明确拒绝并守住专业边界。',
    ].join('\n'),
  },
  {
    id: 'be-bro',
    name: '后端二哥',
    avatar: 'lobe:codex',
    specialty: '服务端逻辑、协议适配、并发控制与性能调优',
    recommendedBody: 'codex',
    soulPrompt: [
      '你是务实可靠的后端二哥，擅长服务端实现与协议处理。',
      '做事准则：',
      '1. 重视并发安全、超时取消、资源释放和清晰的错误边界；',
      '2. 改接口前主动知会前端和架构师对齐数据结构；',
      '3. 对缺少边界校验或可能造成死锁、资源泄漏的改动坚决说不。',
    ].join('\n'),
  },
  {
    id: 'qa-guard',
    name: '审查小弟',
    avatar: 'lobe:deepseek',
    specialty: '代码审查、边界测试编写、回归验证与风险挑刺',
    recommendedBody: 'dsh',
    soulPrompt: [
      '你是家里眼里不揉沙子的审查与测试小弟。',
      '做事准则：',
      '1. 只信真实的运行输出和自动化测试证据，不信口头“应该没问题”；',
      '2. 专门寻找并发竞态、异常断流、空输入和安全漏洞；',
      '3. 发现未覆盖的核心路径时直言不讳指出问题，拒绝带病放行。',
    ].join('\n'),
  },
];

function isBodyKind(value: unknown): value is BodyKind {
  return typeof value === 'string' && (BODY_KINDS as readonly string[]).includes(value);
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

function normalizeBodySpec(input: BodySpec): BodySpec {
  if (!isBodyKind(input.kind)) {
    throw new Error(`不支持的身体类型: ${String(input.kind)}`);
  }
  const permissionMode = isPermissionMode(input.permissionMode)
    ? input.permissionMode
    : undefined;
  const model = input.model?.trim();
  const reasoningEffort = input.reasoningEffort?.trim();
  const command = input.command?.trim();
  const extraArgs = (input.extraArgs ?? [])
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0);
  return {
    kind: input.kind,
    ...(permissionMode ? { permissionMode } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(command ? { command } : {}),
    ...(extraArgs.length > 0 ? { extraArgs } : {}),
  };
}

export function validateMemberId(rawId: string): string {
  const normalized = rawId.trim();
  if (RESERVED_IDS.has(normalized.toLowerCase())) {
    throw new Error(`成员 ID "${normalized}" 为系统保留名称（如 lead），请更换其他代号。`);
  }
  if (!MEMBER_ID_PATTERN.test(normalized)) {
    throw new Error(
      `成员 ID "${normalized}" 格式非法：需以小写字母开头，仅含小写字母、数字与连字符，长度 1-32。`
    );
  }
  return normalized;
}

function parsePersistedMembers(raw: unknown): FamilyMember[] {
  if (!raw || typeof raw !== 'object') return [];
  const record = raw as Record<string, unknown>;
  const items = Array.isArray(record.members) ? record.members : Array.isArray(raw) ? raw : [];
  const parsed: FamilyMember[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    const bodyRaw = candidate.body as Record<string, unknown> | undefined;
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.name !== 'string' ||
      typeof candidate.specialty !== 'string' ||
      typeof candidate.soulPrompt !== 'string' ||
      !bodyRaw ||
      !isBodyKind(bodyRaw.kind)
    ) {
      continue;
    }
    const extraArgsRaw = Array.isArray(bodyRaw.extraArgs)
      ? bodyRaw.extraArgs.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
    parsed.push({
      id: candidate.id,
      name: candidate.name,
      avatar:
        typeof candidate.avatar === 'string' && candidate.avatar.trim()
          ? candidate.avatar.trim()
          : defaultLobeAvatarForBody(bodyRaw.kind),
      specialty: candidate.specialty,
      body: normalizeBodySpec({
        kind: bodyRaw.kind,
        permissionMode: isPermissionMode(bodyRaw.permissionMode)
          ? bodyRaw.permissionMode
          : undefined,
        model: typeof bodyRaw.model === 'string' ? bodyRaw.model : undefined,
        reasoningEffort:
          typeof bodyRaw.reasoningEffort === 'string' ? bodyRaw.reasoningEffort : undefined,
        command: typeof bodyRaw.command === 'string' ? bodyRaw.command : undefined,
        extraArgs: extraArgsRaw,
      }),
      soulPrompt: candidate.soulPrompt,
      enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : true,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
    });
  }
  return parsed;
}

function extractEnvelopeSavedAt(raw: unknown, members: readonly FamilyMember[]): string {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.savedAt === 'string' && rec.savedAt.trim()) {
      return rec.savedAt.trim();
    }
  }
  let maxUpdated = '';
  for (const m of members) {
    if (m.updatedAt > maxUpdated) {
      maxUpdated = m.updatedAt;
    }
  }
  return maxUpdated;
}

export function defaultFamilyStorageDir(): string {
  const dshHome = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return join(dshHome, 'family');
}

export class MemberRegistry {
  private readonly storageDir: string;
  private readonly filePath: string;
  private readonly backupDir: string;
  private readonly latestBackupPath: string;
  private members: FamilyMember[] = [];
  private lastKnownMtimeMs = 0;
  private lastKnownSavedAt = '';
  private readonly listeners = new Set<(members: readonly FamilyMember[]) => void>();

  public constructor(storageDir: string = defaultFamilyStorageDir()) {
    this.storageDir = storageDir;
    this.filePath = join(storageDir, 'members.json');
    this.backupDir = join(storageDir, 'backups');
    this.latestBackupPath = join(this.backupDir, 'members.latest.json');
    this.reload();
  }

  private readParsedFile(path: string): { savedAt: string; members: FamilyMember[] } | null {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      const members = parsePersistedMembers(parsed);
      const savedAt = extractEnvelopeSavedAt(parsed, members);
      return { savedAt, members };
    } catch {
      return null;
    }
  }

  private readFileMtimeMs(path: string): number {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  }

  public reload(): readonly FamilyMember[] {
    const primary = this.readParsedFile(this.filePath);
    const backup = this.readParsedFile(this.latestBackupPath);

    // 防误回滚自愈保护：若主文件被外部工具（如编辑器历史回滚）覆盖成了比自动备份更旧的快照，自动从备份恢复
    if (
      backup &&
      backup.members.length > 0 &&
      (!primary ||
        primary.members.length === 0 ||
        (backup.savedAt && (!primary.savedAt || backup.savedAt > primary.savedAt)))
    ) {
      this.members = backup.members;
      this.lastKnownSavedAt = backup.savedAt;
      this.writeAtomicJson(this.filePath, {
        version: 1,
        savedAt: backup.savedAt || new Date().toISOString(),
        members: this.members,
      });
      this.lastKnownMtimeMs = this.readFileMtimeMs(this.filePath);
      return [...this.members];
    }

    if (!primary) {
      this.members = [];
      this.lastKnownSavedAt = '';
      this.lastKnownMtimeMs = 0;
      return [];
    }

    this.members = primary.members;
    this.lastKnownSavedAt = primary.savedAt;
    this.lastKnownMtimeMs = this.readFileMtimeMs(this.filePath);
    return [...this.members];
  }

  private syncFromDiskIfChanged(): void {
    const diskMtime = this.readFileMtimeMs(this.filePath);
    if (diskMtime === this.lastKnownMtimeMs) return;
    const prevJson = JSON.stringify(this.members);
    this.reload();
    if (JSON.stringify(this.members) !== prevJson) {
      const snapshot = [...this.members];
      for (const listener of this.listeners) {
        listener(snapshot);
      }
    }
  }

  public list(): readonly FamilyMember[] {
    this.syncFromDiskIfChanged();
    return [...this.members];
  }

  public listEnabled(): readonly FamilyMember[] {
    this.syncFromDiskIfChanged();
    return this.members.filter((member) => member.enabled);
  }

  public get(id: string): FamilyMember | undefined {
    this.syncFromDiskIfChanged();
    return this.members.find((member) => member.id === id);
  }

  public subscribe(listener: (members: readonly FamilyMember[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public create(input: CreateMemberInput): FamilyMember {
    const id = validateMemberId(input.id);
    if (this.get(id)) {
      throw new Error(`成员 ID "${id}" 已存在，请使用不同的唯一标识。`);
    }
    const name = input.name.trim();
    if (!name) {
      throw new Error('成员称呼不能为空。');
    }
    const specialty = input.specialty.trim();
    if (!specialty) {
      throw new Error('成员专长描述不能为空。');
    }
    const soulPrompt = input.soulPrompt.trim();
    if (!soulPrompt) {
      throw new Error('灵魂提示词不能为空。');
    }

    const now = new Date().toISOString();
    const normalizedBody = normalizeBodySpec(input.body);
    const member: FamilyMember = {
      id,
      name,
      avatar: input.avatar?.trim() || defaultLobeAvatarForBody(normalizedBody.kind),
      specialty,
      body: normalizedBody,
      soulPrompt,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    this.members = [...this.members, member];
    this.persistAndNotify();
    return member;
  }

  public update(id: string, patch: UpdateMemberInput): FamilyMember {
    const index = this.members.findIndex((item) => item.id === id);
    if (index === -1) {
      throw new Error(`未找到家庭成员 "${id}"。`);
    }
    const current = this.members[index]!;
    const nextName = patch.name !== undefined ? patch.name.trim() : current.name;
    const nextSpecialty = patch.specialty !== undefined ? patch.specialty.trim() : current.specialty;
    const nextSoul = patch.soulPrompt !== undefined ? patch.soulPrompt.trim() : current.soulPrompt;
    if (!nextName || !nextSpecialty || !nextSoul) {
      throw new Error('成员称呼、专长与灵魂提示词均不能为空。');
    }

    const updated: FamilyMember = {
      ...current,
      name: nextName,
      avatar: patch.avatar !== undefined ? patch.avatar.trim() || current.avatar : current.avatar,
      specialty: nextSpecialty,
      body: patch.body !== undefined ? normalizeBodySpec(patch.body) : current.body,
      soulPrompt: nextSoul,
      enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
      updatedAt: new Date().toISOString(),
    };

    const next = [...this.members];
    next[index] = updated;
    this.members = next;
    this.persistAndNotify();
    return updated;
  }

  public remove(id: string): boolean {
    const before = this.members.length;
    this.members = this.members.filter((item) => item.id !== id);
    if (this.members.length === before) {
      return false;
    }
    this.persistAndNotify();
    return true;
  }

  public seedStarterTemplates(preferredBodyFallback?: BodyKind): readonly FamilyMember[] {
    const created: FamilyMember[] = [];
    for (const tpl of STARTER_MEMBER_TEMPLATES) {
      if (this.get(tpl.id)) continue;
      const chosenKind = preferredBodyFallback ?? tpl.recommendedBody;
      created.push(
        this.create({
          id: tpl.id,
          name: tpl.name,
          avatar: preferredBodyFallback ? defaultLobeAvatarForBody(chosenKind) : tpl.avatar,
          specialty: tpl.specialty,
          body: { kind: chosenKind },
          soulPrompt: tpl.soulPrompt,
        })
      );
    }
    return created;
  }

  private writeAtomicJson(targetPath: string, data: unknown): void {
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const payload = JSON.stringify(data, null, 2);
    writeFileSync(tempPath, `${payload}\n`, 'utf8');
    renameSync(tempPath, targetPath);
  }

  private persistAndNotify(): void {
    mkdirSync(this.storageDir, { recursive: true });
    mkdirSync(this.backupDir, { recursive: true });

    const nowIso = new Date().toISOString();
    const savedAt =
      this.lastKnownSavedAt && nowIso <= this.lastKnownSavedAt
        ? new Date(Date.parse(this.lastKnownSavedAt) + 1).toISOString()
        : nowIso;
    this.lastKnownSavedAt = savedAt;

    const envelope = {
      version: 1,
      savedAt,
      members: this.members,
    };

    this.writeAtomicJson(this.filePath, envelope);
    this.lastKnownMtimeMs = this.readFileMtimeMs(this.filePath);

    try {
      this.writeAtomicJson(this.latestBackupPath, envelope);
      const stamp = savedAt.replace(/[:.]/gu, '-');
      const historyPath = join(this.backupDir, `members-${stamp}.json`);
      this.writeAtomicJson(historyPath, envelope);

      const historyFiles = readdirSync(this.backupDir)
        .filter((f) => f.startsWith('members-') && f.endsWith('.json'))
        .sort();
      while (historyFiles.length > 6) {
        const oldest = historyFiles.shift();
        if (oldest) {
          unlinkSync(join(this.backupDir, oldest));
        }
      }
    } catch {
      // ignore backup write errors
    }

    const snapshot = [...this.members];
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
