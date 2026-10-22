import { memo, useState } from "react";
import { parseBlocks, splitInlineTokens } from "./markdownParser";

export interface MarkdownContentProps {
  content: string;
  kind?: string;
}

/**
 * Clean, lightweight, dependency-free Markdown & rich text renderer
 * designed specifically for AI agent transcripts (prompts, replies, tools, thoughts).
 */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  kind = "assistant",
}: MarkdownContentProps) {
  if (!content) return null;

  // For tool results, render as clean terminal/console output
  if (kind === "tool_result") {
    return (
      <div className="artifact-console-box">
        <pre className="artifact-console-pre">
          <code>{content}</code>
        </pre>
      </div>
    );
  }

  // For tool calls, format key-value pairs or command lines nicely
  if (kind === "tool") {
    return <ToolCallContent content={content} />;
  }

  // For user, assistant, and reasoning, parse Markdown blocks
  return <RichMarkdown content={content} isReasoning={kind === "reasoning"} />;
});

function ToolCallContent({ content }: { content: string }) {
  const lines = content.split("\n");
  const isKeyValue = lines.length > 0 && lines.some((line) => /^[A-Za-z0-9_.-]+:/.test(line));

  if (!isKeyValue) {
    return (
      <div className="artifact-tool-box">
        <pre className="artifact-tool-pre">
          <code>{content}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="artifact-tool-box">
      <div className="artifact-tool-entries">
        {lines.map((line, idx) => {
          const colonIdx = line.indexOf(":");
          if (colonIdx > 0 && colonIdx < 30) {
            const key = line.slice(0, colonIdx).trim();
            const val = line.slice(colonIdx + 1).trim();
            return (
              <div key={idx} className="artifact-tool-entry">
                <span className="artifact-tool-key">{key}:</span>
                <span className="artifact-tool-val">{val}</span>
              </div>
            );
          }
          return (
            <div key={idx} className="artifact-tool-raw-line">
              {line}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RichMarkdown({ content, isReasoning }: { content: string; isReasoning: boolean }) {
  const blocks = parseBlocks(content);

  return (
    <div className={`artifact-rich-body${isReasoning ? " is-reasoning" : ""}`}>
      {blocks.map((block, idx) => {
        if (block.type === "code") {
          return (
            <CodeBlock key={idx} code={block.code ?? ""} lang={block.lang ?? "code"} />
          );
        }
        return <MarkdownTextSection key={idx} text={block.text ?? ""} />;
      })}
    </div>
  );
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    void navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const displayLang = lang || "code";

  return (
    <div className="artifact-code-card">
      <div className="artifact-code-head">
        <span className="artifact-code-lang">{displayLang}</span>
        <button
          type="button"
          className="artifact-code-copy-btn"
          onClick={handleCopy}
          title="Copy code"
        >
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <pre className="artifact-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function MarkdownTextSection({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];

  let currentList: { type: "ul" | "ol"; items: string[] } | null = null;
  let currentParagraphLines: string[] = [];

  const flushParagraph = () => {
    if (currentParagraphLines.length > 0) {
      const paragraphText = currentParagraphLines.join("\n").trim();
      if (paragraphText.length > 0) {
        elements.push(
          <p key={`p-${elements.length}`} className="artifact-para">
            <InlineFormat text={paragraphText} />
          </p>,
        );
      }
      currentParagraphLines = [];
    }
  };

  const flushList = () => {
    if (currentList) {
      const { type, items } = currentList;
      if (type === "ul") {
        elements.push(
          <ul key={`ul-${elements.length}`} className="artifact-ul">
            {items.map((item, idx) => (
              <li key={idx}>
                <InlineFormat text={item} />
              </li>
            ))}
          </ul>,
        );
      } else {
        elements.push(
          <ol key={`ol-${elements.length}`} className="artifact-ol">
            {items.map((item, idx) => (
              <li key={idx}>
                <InlineFormat text={item} />
              </li>
            ))}
          </ol>,
        );
      }
      currentList = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    // Headers
    if (trimmed.startsWith("### ")) {
      flushParagraph();
      flushList();
      elements.push(
        <h4 key={`h3-${elements.length}`} className="artifact-h3">
          <InlineFormat text={trimmed.slice(4)} />
        </h4>,
      );
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushParagraph();
      flushList();
      elements.push(
        <h3 key={`h2-${elements.length}`} className="artifact-h2">
          <InlineFormat text={trimmed.slice(3)} />
        </h3>,
      );
      continue;
    }
    if (trimmed.startsWith("# ")) {
      flushParagraph();
      flushList();
      elements.push(
        <h2 key={`h1-${elements.length}`} className="artifact-h1">
          <InlineFormat text={trimmed.slice(2)} />
        </h2>,
      );
      continue;
    }

    // Blockquote
    if (trimmed.startsWith("> ")) {
      flushParagraph();
      flushList();
      elements.push(
        <blockquote key={`quote-${elements.length}`} className="artifact-quote">
          <InlineFormat text={trimmed.slice(2)} />
        </blockquote>,
      );
      continue;
    }

    // Bullet lists: - item, * item, + item
    const bulletMatch = /^[*-+]\s+(.*)$/.exec(trimmed);
    if (bulletMatch) {
      flushParagraph();
      if (!currentList || currentList.type !== "ul") {
        flushList();
        currentList = { type: "ul", items: [] };
      }
      currentList.items.push(bulletMatch[1]);
      continue;
    }

    // Numbered lists: 1. item
    const numberMatch = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (numberMatch) {
      flushParagraph();
      if (!currentList || currentList.type !== "ol") {
        flushList();
        currentList = { type: "ol", items: [] };
      }
      currentList.items.push(numberMatch[1]);
      continue;
    }

    // Otherwise standard paragraph line
    flushList();
    currentParagraphLines.push(rawLine);
  }

  flushParagraph();
  flushList();

  return <>{elements}</>;
}

function InlineFormat({ text }: { text: string }) {
  const tokens = splitInlineTokens(text);

  return (
    <>
      {tokens.map((token, idx) => {
        if (token.type === "code") {
          return (
            <code key={idx} className="artifact-inline-code">
              {token.val}
            </code>
          );
        }
        if (token.type === "bold") {
          return <strong key={idx}>{token.val}</strong>;
        }
        if (token.type === "italic") {
          return <em key={idx}>{token.val}</em>;
        }
        if (token.type === "link") {
          return (
            <a
              key={idx}
              href={token.url}
              className="artifact-link"
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {token.val}
            </a>
          );
        }
        return <span key={idx}>{token.val}</span>;
      })}
    </>
  );
}
