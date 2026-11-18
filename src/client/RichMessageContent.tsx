import { Check, Copy, WrapText } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';

declare const require: ((id: string) => unknown) | undefined;

export interface RichMessageContentProps {
  readonly content: string;
  readonly streaming?: boolean;
  readonly validMemberIds?: ReadonlySet<string>;
  readonly knownFilePaths?: readonly string[];
  readonly onSelectMember?: (memberId: string) => void;
  readonly onOpenFile?: (filePath: string, line?: number) => void;
}

interface HostMarkdownFileMentions {
  resolve(token: string): { open: () => void; label: string } | undefined;
}

interface HostMarkdownLabels {
  readonly code: {
    readonly copyLabel: string;
    readonly copiedLabel: string;
    readonly toolbarLabels: {
      readonly codeLabel: string;
      readonly wrapLabel: string;
      readonly unwrapLabel: string;
    };
  };
  readonly footnotes: string;
}

interface HostMarkdownTextProps {
  readonly text: string;
  readonly labels: HostMarkdownLabels;
  readonly streaming?: boolean;
  readonly fileMentions?: HostMarkdownFileMentions;
}

interface HostMarkdownDelegateProviderProps {
  readonly openFile?: (destination: string, options?: { line?: number }) => void;
  readonly fileImages?: {
    readonly fileDrag: {
      prepare: () => Promise<{ start: () => boolean; release: () => void }>;
      reportFailure: () => void;
    };
    readonly resolve: () => string | undefined;
    readonly labels: {
      readonly open: string;
      readonly loading: string;
      readonly failed: string;
      readonly dialog: string;
      readonly close: string;
    };
  };
  readonly children?: React.ReactNode;
}

interface HostMarkdownPrimitives {
  readonly MarkdownText: React.ComponentType<HostMarkdownTextProps>;
  readonly MarkdownDelegateProvider: React.ComponentType<HostMarkdownDelegateProviderProps>;
}

const HOST_MARKDOWN_LABELS: HostMarkdownLabels = Object.freeze({
  code: Object.freeze({
    copyLabel: '复制',
    copiedLabel: '已复制',
    toolbarLabels: Object.freeze({
      codeLabel: '代码',
      wrapLabel: '自动换行',
      unwrapLabel: '取消换行',
    }),
  }),
  footnotes: '',
});

const HOST_FILE_IMAGES = Object.freeze({
  fileDrag: {
    prepare: async () => ({ start: () => true, release: () => {} }),
    reportFailure: () => {},
  },
  resolve: (): string | undefined => undefined,
  labels: {
    open: '预览图片',
    loading: '正在加载图片…',
    failed: '图片加载失败',
    dialog: '图片预览',
    close: '关闭预览',
  },
});

const MEMBER_LINK_PREFIX = '__family_member__/';

let cachedHostPrimitives: HostMarkdownPrimitives | null | undefined;

function getHostMarkdownPrimitives(): HostMarkdownPrimitives | null {
  if (cachedHostPrimitives !== undefined) {
    return cachedHostPrimitives;
  }
  try {
    if (typeof require === 'function') {
      const mod = require('@deepseek-ai/dsh-client-ui-primitives') as
        | Record<string, unknown>
        | undefined;
      if (
        mod &&
        typeof mod.MarkdownText === 'function' &&
        typeof mod.MarkdownDelegateProvider === 'function'
      ) {
        cachedHostPrimitives = {
          MarkdownText: mod.MarkdownText as React.ComponentType<HostMarkdownTextProps>,
          MarkdownDelegateProvider:
            mod.MarkdownDelegateProvider as React.ComponentType<HostMarkdownDelegateProviderProps>,
        };
        return cachedHostPrimitives;
      }
    }
  } catch {
    // 独立浏览器预览或单元测试环境未挂载 DSH ModuleLoader 时走内置完整 Markdown 渲染器
  }
  cachedHostPrimitives = null;
  return null;
}

function baseNameOf(p: string): string {
  const clean = p.replace(/\\/gu, '/');
  const idx = clean.lastIndexOf('/');
  return idx === -1 ? clean : clean.slice(idx + 1);
}

const LIKELY_WORKSPACE_FILE_RE =
  /^(?:\.\/)?(?:[A-Za-z0-9_.\u4e00-\u9fa5-]+\/)+[A-Za-z0-9_.\u4e00-\u9fa5-]+\.[A-Za-z0-9]{1,10}(?:#L\d+)?$/u;
const ROOT_DOC_FILE_RE =
  /^(?:SKILL|README|CHANGELOG|AGENTS|CLAUDE|LICENSE|package|tsconfig|Cargo|Makefile|Dockerfile)(?:\.[A-Za-z0-9_-]+)*(?:\.[A-Za-z0-9]{1,8})?(?:#L\d+)?$/u;

export function parsePathAndLine(rawToken: string): { path: string; line?: number } {
  const trimmed = rawToken.trim();
  const hashMatch = /^(.*?)#L(\d+)(?:-L?\d+)?$/u.exec(trimmed);
  if (hashMatch && hashMatch[1]) {
    return {
      path: hashMatch[1],
      line: Number.parseInt(hashMatch[2] ?? '1', 10),
    };
  }
  const colonMatch = /^(.*?):(\d+)(?::\d+)?$/u.exec(trimmed);
  if (colonMatch && colonMatch[1] && !colonMatch[1].includes('://')) {
    return {
      path: colonMatch[1],
      line: Number.parseInt(colonMatch[2] ?? '1', 10),
    };
  }
  return { path: trimmed };
}

function resolveInlineFileTarget(
  knownPaths: readonly string[],
  rawToken: string
): { path: string; line?: number } | undefined {
  const { path: wanted, line } = parsePathAndLine(rawToken);
  if (!wanted || wanted.includes(' ') || wanted.includes('://')) {
    return undefined;
  }

  if (knownPaths.length > 0) {
    let matched: string | undefined;
    let ambiguous = false;
    for (const candidate of knownPaths) {
      if (candidate === wanted || baseNameOf(candidate) === wanted) {
        if (matched !== undefined && matched !== candidate) {
          ambiguous = true;
          break;
        }
        matched = candidate;
      }
    }
    if (matched && !ambiguous) {
      return { path: matched, ...(line !== undefined ? { line } : {}) };
    }
  }

  if (LIKELY_WORKSPACE_FILE_RE.test(wanted) || ROOT_DOC_FILE_RE.test(wanted)) {
    return { path: wanted.replace(/^\.\//u, ''), ...(line !== undefined ? { line } : {}) };
  }
  return undefined;
}

/**
 * 在不破坏代码块和行内反引号的前提下，将普通正文中的 `@成员ID` 转为受控本地链接，
 * 交给 `MarkdownDelegateProvider.openFile` 拦截实现成员跳转。
 */
export function rewriteMemberMentionsForHostMarkdown(
  markdown: string,
  validMemberIds?: ReadonlySet<string>,
  hasSelectHandler?: boolean
): string {
  if (!hasSelectHandler || !markdown.includes('@')) {
    return markdown;
  }

  // 保护三引号代码块、行内代码以及已有的 Markdown 链接 [...] (...)
  const protectedRe = /(```[\s\S]*?```|`[^`\n]+`|\[[^\]]*\]\([^)]*\))/gu;
  let result = '';
  let cursor = 0;

  const replacePlainChunk = (chunk: string): string =>
    chunk.replace(/(^|[^A-Za-z0-9_/`])@([a-z][a-z0-9-]{0,31})\b/gu, (full, prefix: string, id: string) => {
      if (validMemberIds && !validMemberIds.has(id)) {
        return full;
      }
      return `${prefix}[@${id}](${MEMBER_LINK_PREFIX}${id})`;
    });

  for (const match of markdown.matchAll(protectedRe)) {
    const idx = match.index ?? 0;
    if (idx > cursor) {
      result += replacePlainChunk(markdown.slice(cursor, idx));
    }
    result += match[0];
    cursor = idx + match[0].length;
  }
  if (cursor < markdown.length) {
    result += replacePlainChunk(markdown.slice(cursor));
  }
  return result;
}

/* ============================================================================
 * 独立环境完整增强型 Markdown 兜底渲染器（支持 H1-H6、表格、引用、有序/无序列表、代码块、链接、@成员、文件点击）
 * ========================================================================== */

interface ParsedSegment {
  readonly kind: 'codeblock' | 'text';
  readonly lang?: string;
  readonly value: string;
}

function splitCodeBlocks(raw: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const fenceRegex = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/gu;
  let lastIndex = 0;

  for (const match of raw.matchAll(fenceRegex)) {
    // 仅当确实出现开头 ``` 时分割（兼容流式未闭合代码块）
    if (!match[0].startsWith('```')) continue;
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ kind: 'text', value: raw.slice(lastIndex, start) });
    }
    segments.push({
      kind: 'codeblock',
      lang: match[1] || 'code',
      value: (match[2] ?? '').replace(/\n$/u, ''),
    });
    lastIndex = start + match[0].length;
  }

  if (lastIndex < raw.length) {
    segments.push({ kind: 'text', value: raw.slice(lastIndex) });
  }
  return segments;
}

function renderInlineTokens(
  line: string,
  options: {
    readonly validMemberIds?: ReadonlySet<string>;
    readonly knownFilePaths?: readonly string[];
    readonly onSelectMember?: (memberId: string) => void;
    readonly onOpenFile?: (filePath: string, line?: number) => void;
  }
): React.ReactNode[] {
  const { validMemberIds, knownFilePaths = [], onSelectMember, onOpenFile } = options;
  const nodes: React.ReactNode[] = [];
  const tokenRegex =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|~~[^~\n]+~~|\*[^*\s][^*\n]*?\*|\[[^\]]+\]\([^)\s]+\)|@[a-z][a-z0-9-]{0,31}\b)/gu;
  let cursor = 0;
  let keySeq = 0;

  for (const match of line.matchAll(tokenRegex)) {
    const idx = match.index ?? 0;
    if (idx > cursor) {
      nodes.push(line.slice(cursor, idx));
    }
    const token = match[0];
    keySeq += 1;

    if (token.startsWith('`') && token.endsWith('`')) {
      const inner = token.slice(1, -1);
      if (inner.startsWith('@') && onSelectMember) {
        const mId = inner.slice(1);
        if (!validMemberIds || validMemberIds.has(mId)) {
          nodes.push(
            <button
              key={keySeq}
              type="button"
              className="sh-mention-pill"
              onClick={() => onSelectMember(mId)}
              title={`查看 @${mId}`}
            >
              {inner}
            </button>
          );
          cursor = idx + token.length;
          continue;
        }
      }
      const fileTarget = onOpenFile ? resolveInlineFileTarget(knownFilePaths, inner) : undefined;
      if (fileTarget && onOpenFile) {
        nodes.push(
          <button
            key={keySeq}
            type="button"
            className="sh-inline-code sh-inline-file-link"
            onClick={() => onOpenFile(fileTarget.path, fileTarget.line)}
            title={`在侧边栏打开 ${fileTarget.path}${fileTarget.line ? `:${fileTarget.line}` : ''}`}
          >
            {inner}
          </button>
        );
      } else {
        nodes.push(
          <code key={keySeq} className="sh-inline-code">
            {inner}
          </code>
        );
      }
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={keySeq}>{renderInlineTokens(token.slice(2, -2), options)}</strong>);
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      nodes.push(<del key={keySeq}>{token.slice(2, -2)}</del>);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(<em key={keySeq}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith('[')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(token);
      if (linkMatch) {
        const label = linkMatch[1] ?? '';
        const href = linkMatch[2] ?? '';
        if (/^https?:\/\//iu.test(href)) {
          nodes.push(
            <a
              key={keySeq}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="sh-md-link"
            >
              {label}
            </a>
          );
        } else if (onOpenFile) {
          const parsed = parsePathAndLine(href);
          nodes.push(
            <button
              key={keySeq}
              type="button"
              className="sh-md-link-btn"
              onClick={() => onOpenFile(parsed.path, parsed.line)}
              title={`打开 ${parsed.path}`}
            >
              {label}
            </button>
          );
        } else {
          nodes.push(label);
        }
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith('@')) {
      const memberId = token.slice(1);
      if (!validMemberIds || validMemberIds.has(memberId)) {
        nodes.push(
          <button
            key={keySeq}
            type="button"
            className="sh-mention-pill"
            onClick={() => onSelectMember?.(memberId)}
            title={`查看 @${memberId}`}
          >
            @{memberId}
          </button>
        );
      } else {
        nodes.push(token);
      }
    }
    cursor = idx + token.length;
  }

  if (cursor < line.length) {
    nodes.push(line.slice(cursor));
  }
  return nodes;
}

function CodeBlockCard({
  lang,
  code,
}: {
  readonly lang: string;
  readonly code: string;
}): React.ReactElement {
  const [copied, setCopied] = useState<boolean>(false);
  const [wrapped, setWrapped] = useState<boolean>(false);

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="sh-codeblock">
      <div className="sh-codeblock-head">
        <span>{lang || 'code'}</span>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            onClick={() => setWrapped((v) => !v)}
            title={wrapped ? '取消自动换行' : '自动换行'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 11,
              opacity: wrapped ? 1 : 0.72,
            }}
          >
            <WrapText size={12} />
            <span>{wrapped ? '取消换行' : '换行'}</span>
          </button>
          <button
            type="button"
            onClick={handleCopy}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>
      <pre style={wrapped ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' } : undefined}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function splitTableCells(rowLine: string): string[] {
  const trimmed = rowLine.trim().replace(/^\|/u, '').replace(/\|$/u, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') && !trimmed.includes('-')) return false;
  const cells = splitTableCells(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/u.test(c));
}

function renderMarkdownBlocksFallback(
  rawText: string,
  inlineOpts: {
    readonly validMemberIds?: ReadonlySet<string>;
    readonly knownFilePaths?: readonly string[];
    readonly onSelectMember?: (memberId: string) => void;
    readonly onOpenFile?: (filePath: string, line?: number) => void;
  }
): React.ReactNode[] {
  const lines = rawText.replace(/\r\n/gu, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // 1. 水平分割线
    if (/^(?:-{3,}|\*{3,}|_{3,})$/u.test(trimmed)) {
      key += 1;
      blocks.push(<hr key={key} className="sh-md-hr" />);
      i += 1;
      continue;
    }

    // 2. 标题 H1 ~ H6
    const headingMatch = /^(#{1,6})\s+(.+)$/u.exec(trimmed);
    if (headingMatch) {
      const level = Math.min(6, (headingMatch[1] ?? '#').length) as 1 | 2 | 3 | 4 | 5 | 6;
      const text = (headingMatch[2] ?? '').replace(/\s+#+\s*$/u, '');
      const Tag = `h${level}` as const;
      key += 1;
      blocks.push(
        <Tag key={key} className={`sh-md-h sh-md-h${level}`}>
          {renderInlineTokens(text, inlineOpts)}
        </Tag>
      );
      i += 1;
      continue;
    }

    // 3. GFM 表格
    const nextLine = lines[i + 1];
    if (trimmed.includes('|') && nextLine !== undefined && isTableSeparatorLine(nextLine)) {
      const headers = splitTableCells(trimmed);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length) {
        const rowLine = (lines[i] ?? '').trim();
        if (!rowLine || !rowLine.includes('|')) break;
        bodyRows.push(splitTableCells(rowLine));
        i += 1;
      }
      key += 1;
      blocks.push(
        <div key={key} className="sh-md-table-wrap">
          <table className="sh-md-table">
            <thead>
              <tr>
                {headers.map((h, hIdx) => (
                  <th key={hIdx}>{renderInlineTokens(h, inlineOpts)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((r, rIdx) => (
                <tr key={rIdx}>
                  {headers.map((_, cIdx) => (
                    <td key={cIdx}>{renderInlineTokens(r[cIdx] ?? '', inlineOpts)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // 4. 引用块 >
    if (/^>\s?/u.test(trimmed)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/u.test((lines[i] ?? '').trim())) {
        quoteLines.push((lines[i] ?? '').trim().replace(/^>\s?/u, ''));
        i += 1;
      }
      key += 1;
      blocks.push(
        <blockquote key={key} className="sh-md-blockquote">
          {quoteLines.map((ql, qIdx) => (
            <React.Fragment key={qIdx}>
              {qIdx > 0 && <br />}
              {renderInlineTokens(ql, inlineOpts)}
            </React.Fragment>
          ))}
        </blockquote>
      );
      continue;
    }

    // 5. 无序列表
    if (/^\s*[-*•]\s+/u.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/u.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*[-*•]\s+/u, ''));
        i += 1;
      }
      key += 1;
      blocks.push(
        <ul key={key}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineTokens(item, inlineOpts)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // 6. 有序列表
    if (/^\s*\d+[.)]\s+/u.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/u.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/u, ''));
        i += 1;
      }
      key += 1;
      blocks.push(
        <ol key={key}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInlineTokens(item, inlineOpts)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // 7. 普通段落（遇到下一个块级语法提前收束）
    const paraLines: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const peek = lines[i] ?? '';
      const peekTrim = peek.trim();
      if (
        !peekTrim ||
        /^(#{1,6})\s+/u.test(peekTrim) ||
        /^(?:-{3,}|\*{3,}|_{3,})$/u.test(peekTrim) ||
        /^>\s?/u.test(peekTrim) ||
        /^\s*[-*•]\s+/u.test(peek) ||
        /^\s*\d+[.)]\s+/u.test(peek) ||
        (peekTrim.includes('|') &&
          lines[i + 1] !== undefined &&
          isTableSeparatorLine(lines[i + 1] ?? ''))
      ) {
        break;
      }
      paraLines.push(peek);
      i += 1;
    }

    key += 1;
    blocks.push(
      <p key={key}>
        {paraLines.map((pl, pIdx) => (
          <React.Fragment key={pIdx}>
            {pIdx > 0 && <br />}
            {renderInlineTokens(pl, inlineOpts)}
          </React.Fragment>
        ))}
      </p>
    );
  }

  return blocks;
}

export function RichMessageContent({
  content,
  streaming = false,
  validMemberIds,
  knownFilePaths = [],
  onSelectMember,
  onOpenFile,
}: RichMessageContentProps): React.ReactElement {
  const hostPrimitives = getHostMarkdownPrimitives();

  const knownPathsKey = knownFilePaths.join('\n');
  const memberIdsKey = useMemo(
    () => (validMemberIds ? Array.from(validMemberIds).sort().join(',') : ''),
    [validMemberIds]
  );

  const rewrittenText = useMemo(
    () =>
      hostPrimitives
        ? rewriteMemberMentionsForHostMarkdown(content, validMemberIds, Boolean(onSelectMember))
        : content,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hostPrimitives, content, memberIdsKey, Boolean(onSelectMember)]
  );

  const handleHostOpenFile = useCallback(
    (destination: string, options?: { line?: number }) => {
      if (destination.startsWith(MEMBER_LINK_PREFIX)) {
        const memberId = decodeURIComponent(destination.slice(MEMBER_LINK_PREFIX.length));
        if (memberId) {
          onSelectMember?.(memberId);
        }
        return;
      }
      const parsed = parsePathAndLine(destination);
      onOpenFile?.(parsed.path, options?.line ?? parsed.line);
    },
    [onSelectMember, onOpenFile]
  );

  const hostFileMentions = useMemo<HostMarkdownFileMentions | undefined>(() => {
    if (!onOpenFile && !onSelectMember) return undefined;
    return {
      resolve: (token: string) => {
        const trimmed = token.trim();
        if (!trimmed) return undefined;
        if (trimmed.startsWith('@') && onSelectMember) {
          const mId = trimmed.slice(1);
          if (!validMemberIds || validMemberIds.has(mId)) {
            return {
              open: () => onSelectMember(mId),
              label: `查看家庭成员 @${mId}`,
            };
          }
        }
        if (onOpenFile) {
          const fileTarget = resolveInlineFileTarget(knownFilePaths, trimmed);
          if (fileTarget) {
            return {
              open: () => onOpenFile(fileTarget.path, fileTarget.line),
              label: `在侧边栏打开 ${fileTarget.path}${fileTarget.line ? `:${fileTarget.line}` : ''}`,
            };
          }
        }
        return undefined;
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownPathsKey, memberIdsKey, onOpenFile, onSelectMember]);

  // 优先复用 DSH 宿主原生的流式 MarkdownText + MarkdownDelegateProvider（与左屏主对话 100% 视觉同构）
  if (hostPrimitives) {
    const { MarkdownText, MarkdownDelegateProvider } = hostPrimitives;
    return (
      <div className="sh-prose sh-host-markdown">
        <MarkdownDelegateProvider openFile={handleHostOpenFile} fileImages={HOST_FILE_IMAGES}>
          <MarkdownText
            text={rewrittenText}
            labels={HOST_MARKDOWN_LABELS}
            streaming={streaming}
            {...(hostFileMentions ? { fileMentions: hostFileMentions } : {})}
          />
        </MarkdownDelegateProvider>
      </div>
    );
  }

  // 独立环境完整 Markdown 渲染兜底
  const segments = splitCodeBlocks(content);
  const inlineOpts = {
    validMemberIds,
    knownFilePaths,
    onSelectMember,
    onOpenFile,
  };

  return (
    <div className="sh-prose">
      {segments.map((seg, idx) => {
        if (seg.kind === 'codeblock') {
          return <CodeBlockCard key={idx} lang={seg.lang ?? 'code'} code={seg.value} />;
        }
        return <React.Fragment key={idx}>{renderMarkdownBlocksFallback(seg.value, inlineOpts)}</React.Fragment>;
      })}
    </div>
  );
}
