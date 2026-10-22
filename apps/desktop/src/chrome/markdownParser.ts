export interface CodeBlockPart {
  type: "code";
  lang: string;
  code: string;
}

export interface MarkdownBlockPart {
  type: "markdown";
  text: string;
}

export type BlockPart = CodeBlockPart | MarkdownBlockPart;

export function parseBlocks(raw: string): BlockPart[] {
  const parts: BlockPart[] = [];
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)(?:```|$)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      const text = raw.slice(lastIndex, match.index);
      if (text.trim().length > 0) {
        parts.push({ type: "markdown", text });
      }
    }

    const lang = (match[1] || "").trim().toLowerCase();
    const code = (match[2] || "").replace(/\n$/, "");
    parts.push({ type: "code", lang, code });

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < raw.length) {
    const text = raw.slice(lastIndex);
    if (text.trim().length > 0) {
      parts.push({ type: "markdown", text });
    }
  }

  return parts;
}

export interface InlineToken {
  type: "text" | "code" | "bold" | "italic" | "link";
  val: string;
  url?: string;
}

export function splitInlineTokens(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let remaining = input;

  while (remaining.length > 0) {
    // 1. Inline code: `code`
    const codeMatch = /^`([^`]+)`/.exec(remaining);
    if (codeMatch) {
      tokens.push({ type: "code", val: codeMatch[1] });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // 2. Bold: **bold**
    const boldMatch = /^\*\*([^*]+)\*\*/.exec(remaining);
    if (boldMatch) {
      tokens.push({ type: "bold", val: boldMatch[1] });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // 3. Link: [text](url)
    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)/.exec(remaining);
    if (linkMatch) {
      tokens.push({ type: "link", val: linkMatch[1], url: linkMatch[2] });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // 4. Italic: *italic* (not followed by another *)
    const italicMatch = /^\*([^*]+)\*/.exec(remaining);
    if (italicMatch) {
      tokens.push({ type: "italic", val: italicMatch[1] });
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Plain text up to the next special character: `, *, [
    const nextSpecial = remaining.search(/[`*[]/);
    if (nextSpecial === -1) {
      tokens.push({ type: "text", val: remaining });
      break;
    } else if (nextSpecial === 0) {
      tokens.push({ type: "text", val: remaining[0] });
      remaining = remaining.slice(1);
    } else {
      tokens.push({ type: "text", val: remaining.slice(0, nextSpecial) });
      remaining = remaining.slice(nextSpecial);
    }
  }

  return tokens;
}
