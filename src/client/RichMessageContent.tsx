import { Check, Copy } from "lucide-react";
import React, { useState } from "react";

export interface RichMessageContentProps {
  readonly content: string;
  readonly validMemberIds?: ReadonlySet<string>;
  readonly onSelectMember?: (memberId: string) => void;
}

interface ParsedSegment {
  readonly kind: "codeblock" | "text";
  readonly lang?: string;
  readonly value: string;
}

function splitCodeBlocks(raw: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  const fenceRegex = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/gu;
  let lastIndex = 0;

  for (const match of raw.matchAll(fenceRegex)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      segments.push({ kind: "text", value: raw.slice(lastIndex, start) });
    }
    segments.push({
      kind: "codeblock",
      lang: match[1] || "code",
      value: (match[2] ?? "").replace(/\n$/u, ""),
    });
    lastIndex = start + match[0].length;
  }

  if (lastIndex < raw.length) {
    segments.push({ kind: "text", value: raw.slice(lastIndex) });
  }
  return segments;
}

function renderInlineTokens(
  line: string,
  validMemberIds?: ReadonlySet<string>,
  onSelectMember?: (memberId: string) => void,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRegex = /(`[^`]+`|\*\*[^*]+\*\*|@[a-z][a-z0-9-]{0,31}\b)/gu;
  let cursor = 0;
  let keySeq = 0;

  for (const match of line.matchAll(tokenRegex)) {
    const idx = match.index ?? 0;
    if (idx > cursor) {
      nodes.push(line.slice(cursor, idx));
    }
    const token = match[0];
    keySeq += 1;

    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code key={keySeq} className="sh-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={keySeq}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("@")) {
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
          </button>,
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

  const handleCopy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="sh-codeblock">
      <div className="sh-codeblock-head">
        <span>{lang}</span>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            background: "transparent",
            border: "none",
            color: "inherit",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function RichMessageContent({
  content,
  validMemberIds,
  onSelectMember,
}: RichMessageContentProps): React.ReactElement {
  const segments = splitCodeBlocks(content);

  return (
    <div className="sh-prose">
      {segments.map((seg, idx) => {
        if (seg.kind === "codeblock") {
          return (
            <CodeBlockCard
              key={idx}
              lang={seg.lang ?? "code"}
              code={seg.value}
            />
          );
        }

        const paragraphs = seg.value.split(/\n{2,}/u);
        return (
          <React.Fragment key={idx}>
            {paragraphs.map((para, pIdx) => {
              const trimmed = para.trim();
              if (!trimmed) return null;
              const lines = trimmed.split("\n");
              const isBulletList = lines.every((l) => /^\s*[-*•]\s+/u.test(l));

              if (isBulletList) {
                return (
                  <ul key={pIdx}>
                    {lines.map((l, lIdx) => (
                      <li key={lIdx}>
                        {renderInlineTokens(
                          l.replace(/^\s*[-*•]\s+/u, ""),
                          validMemberIds,
                          onSelectMember,
                        )}
                      </li>
                    ))}
                  </ul>
                );
              }

              return (
                <p key={pIdx}>
                  {lines.map((line, lIdx) => (
                    <React.Fragment key={lIdx}>
                      {lIdx > 0 && <br />}
                      {renderInlineTokens(line, validMemberIds, onSelectMember)}
                    </React.Fragment>
                  ))}
                </p>
              );
            })}
          </React.Fragment>
        );
      })}
    </div>
  );
}
