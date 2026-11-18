import type { ApprovalOption, PermissionMode } from './types.ts';

export interface PermissionModeMeta {
  readonly value: PermissionMode;
  readonly shortLabel: string;
  readonly label: string;
  readonly description: string;
}

export const PERMISSION_MODE_METAS: readonly PermissionModeMeta[] = [
  {
    value: 'ask',
    shortLabel: '每次询问',
    label: '每次询问 (Ask)',
    description: '执行命令、读写修改与向用户提问前均需要你点击确认',
  },
  {
    value: 'auto',
    shortLabel: '自动模式',
    label: '自动模式 (Auto)',
    description: '常规文件读写与安全命令自动放行，仅高危操作与向你提问 (AskUser) 时请求确认',
  },
  {
    value: 'full_access',
    shortLabel: '完全访问',
    label: '完全访问 (Full Access)',
    description: '全部工具、读写与命令均自动放行，仅成员向你提问 (AskUser) 时需要你回答',
  },
];

const ASK_USER_TOOL_NAMES = new Set([
  'askuserquestion',
  'ask_user',
  'askuser',
  'ask_question',
  'askquestion',
  'request_user_input',
]);

const DANGEROUS_COMMAND_RULES: ReadonlyArray<{
  readonly regex: RegExp;
  readonly reason: string;
}> = [
  {
    regex: /(?:^|[;&|()\s])sudo\s+/iu,
    reason: '提权执行 sudo',
  },
  {
    regex: /(?:^|[;&|()\s])rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force)\b/iu,
    reason: '强制或递归删除文件 (rm -rf)',
  },
  {
    regex: /(?:^|[;&|()\s])git\s+reset\s+--hard\b/iu,
    reason: '丢弃未提交改动 (git reset --hard)',
  },
  {
    regex: /(?:^|[;&|()\s])git\s+clean\s+-[a-zA-Z]*f/iu,
    reason: '清理未跟踪文件 (git clean -f)',
  },
  {
    regex: /(?:^|[;&|()\s])git\s+push\b[^\n]*(?:--force(?:-with-lease)?|\s-f(?:\s|$))/iu,
    reason: '强制推送远端分支 (git push --force)',
  },
  {
    regex: /(?:^|[;&|()\s])git\s+(?:checkout|restore)\s+(?:--\s+)?\.(?:\s|$)/iu,
    reason: '批量还原工作区改动',
  },
  {
    regex: /(?:^|[;&|()\s])(?:mkfs|fdisk|diskutil\s+erase|dd\s+if=|shutdown|reboot|halt)\b/iu,
    reason: '系统或磁盘级破坏性指令',
  },
  {
    regex: /(?:^|[;&|()\s])chmod\s+(?:-R\s+)?777\b/iu,
    reason: '开放高风险全局可写权限 (chmod 777)',
  },
  {
    regex: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/iu,
    reason: '高危数据库删表/清空操作',
  },
  {
    regex: /(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z)?sh\b/iu,
    reason: '管道直接执行远程脚本',
  },
  {
    regex: /(?:^|[;&|()\s])(?:npm|pnpm|yarn)\s+publish\b/iu,
    reason: '向包仓库正式发布产物',
  },
];

const SENSITIVE_PATH_PATTERN =
  /(?:^|[\s"'`])(?:\/etc\/|\/System\/|\/usr\/bin\/|~\/\.ssh\/|\.ssh\/id_|\.env\.prod|\.credentials)/iu;

export interface PermissionCheckContext {
  readonly toolName?: string;
  readonly method?: string;
  readonly commandText?: string;
  readonly rawInput?: unknown;
}

export interface PermissionDecisionResult {
  readonly decision: 'auto_allow' | 'prompt_user';
  readonly isAskUser: boolean;
  readonly isDangerous: boolean;
  readonly reason?: string;
}

export function isAskUserInteraction(ctx: PermissionCheckContext): boolean {
  if (ctx.method === 'item/tool/requestUserInput') {
    return true;
  }
  const normalizedTool = (ctx.toolName ?? '')
    .trim()
    .toLowerCase()
    .replace(/^mcp__[^_]+__/u, '');
  if (ASK_USER_TOOL_NAMES.has(normalizedTool)) {
    return true;
  }
  if (normalizedTool.includes('ask_user') || normalizedTool.includes('askuserquestion')) {
    return true;
  }
  return false;
}

export function assessOperationDanger(ctx: PermissionCheckContext): {
  readonly isDangerous: boolean;
  readonly reason?: string;
} {
  const candidates: string[] = [];
  if (ctx.commandText && ctx.commandText.trim()) {
    candidates.push(ctx.commandText.trim());
  }
  if (ctx.rawInput && typeof ctx.rawInput === 'object') {
    const obj = ctx.rawInput as Record<string, unknown>;
    if (typeof obj.command === 'string') candidates.push(obj.command);
    if (Array.isArray(obj.command)) {
      candidates.push(obj.command.filter((x): x is string => typeof x === 'string').join(' '));
    }
    for (const key of ['file_path', 'path', 'filePath', 'target_file']) {
      if (typeof obj[key] === 'string') {
        const p = obj[key] as string;
        if (SENSITIVE_PATH_PATTERN.test(p)) {
          return { isDangerous: true, reason: `访问敏感系统或凭证路径 (${p})` };
        }
      }
    }
  }

  for (const cmd of candidates) {
    for (const rule of DANGEROUS_COMMAND_RULES) {
      if (rule.regex.test(cmd)) {
        return { isDangerous: true, reason: rule.reason };
      }
    }
    if (SENSITIVE_PATH_PATTERN.test(cmd) && /\b(?:rm|mv|cp|tee|sed\s+-i|>)\b/u.test(cmd)) {
      return { isDangerous: true, reason: '修改敏感系统或密钥文件' };
    }
  }

  return { isDangerous: false };
}

export function decidePermissionAction(
  mode: PermissionMode | undefined,
  ctx: PermissionCheckContext
): PermissionDecisionResult {
  const effectiveMode: PermissionMode = mode ?? 'ask';

  // 1. 无论在哪种模式下（包括完全访问 full_access），向人类提问 (AskUser) 永远必须由用户回答确认！
  if (isAskUserInteraction(ctx)) {
    return {
      decision: 'prompt_user',
      isAskUser: true,
      isDangerous: false,
    };
  }

  const danger = assessOperationDanger(ctx);

  // 2. 每次询问模式 (ask)：所有操作均请求用户批示
  if (effectiveMode === 'ask') {
    return {
      decision: 'prompt_user',
      isAskUser: false,
      isDangerous: danger.isDangerous,
      reason: danger.reason,
    };
  }

  // 3. 自动模式 (auto)：仅高危操作请求批示，常规读写与安全命令自动放行
  if (effectiveMode === 'auto') {
    if (danger.isDangerous) {
      return {
        decision: 'prompt_user',
        isAskUser: false,
        isDangerous: true,
        reason: danger.reason,
      };
    }
    return {
      decision: 'auto_allow',
      isAskUser: false,
      isDangerous: false,
    };
  }

  // 4. 完全访问模式 (full_access)：除 AskUser 外全部自动放行
  return {
    decision: 'auto_allow',
    isAskUser: false,
    isDangerous: danger.isDangerous,
    reason: danger.reason,
  };
}

export interface ExtractedAskUserPrompt {
  readonly questionId: string;
  readonly questionText: string;
  readonly detailText?: string;
  readonly options: readonly ApprovalOption[];
}

export function extractAskUserPrompt(rawInput: unknown): ExtractedAskUserPrompt {
  const obj =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  const questions = Array.isArray(obj.questions) ? obj.questions : [];
  const first =
    questions[0] && typeof questions[0] === 'object'
      ? (questions[0] as Record<string, unknown>)
      : obj;

  const questionId =
    typeof first.id === 'string' && first.id
      ? first.id
      : typeof first.question === 'string' && first.question
        ? first.question
        : 'default';
  const questionText =
    typeof first.question === 'string' && first.question.trim()
      ? first.question.trim()
      : typeof obj.question === 'string' && obj.question.trim()
        ? obj.question.trim()
        : '成员向你请教一个问题';

  const rawOptions = Array.isArray(first.options) ? first.options : [];
  const options: ApprovalOption[] = [];
  for (const item of rawOptions) {
    if (typeof item === 'string' && item.trim()) {
      options.push({
        optionId: `answer:${item.trim()}`,
        label: item.trim(),
        kind: 'allow',
      });
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const label = typeof o.label === 'string' ? o.label.trim() : '';
      if (label) {
        options.push({
          optionId: `answer:${label}`,
          label,
          kind: 'allow',
        });
      }
    }
  }

  if (options.length === 0) {
    options.push(
      { optionId: 'answer:确认继续', label: '确认继续', kind: 'allow' },
      { optionId: 'deny', label: '暂不执行', kind: 'deny' }
    );
  }

  const extraQuestions =
    questions.length > 1
      ? questions
          .slice(1)
          .map((q) => {
            const qObj = q && typeof q === 'object' ? (q as Record<string, unknown>) : {};
            return typeof qObj.question === 'string' ? `- ${qObj.question}` : '';
          })
          .filter(Boolean)
          .join('\n')
      : undefined;

  return {
    questionId,
    questionText,
    ...(extraQuestions ? { detailText: extraQuestions } : {}),
    options,
  };
}
