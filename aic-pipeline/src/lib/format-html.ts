// Lightweight HTML pretty-printer.
// Goals: deterministic, fast, no external deps. Handles self-closing tags,
// void elements, comments, doctype, and preserves the literal content of
// <pre>, <script>, and <style> blocks (which must not be re-indented).
//
// This is intentionally small — it does not parse attributes deeply or
// validate markup. It is good enough for email-template HTML stored as
// .md/.html alongside FR config.

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const PRESERVE_TAGS = new Set(["pre", "script", "style", "textarea"]);

const INLINE_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "dfn",
  "em", "i", "kbd", "mark", "q", "rp", "rt", "ruby", "s", "samp",
  "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr",
]);

interface Token {
  type: "open" | "close" | "selfclose" | "text" | "comment" | "doctype" | "preserve";
  name?: string;          // tag name (lowercase) for tag tokens
  raw: string;            // raw token text (for tag/comment/text/doctype)
  content?: string;       // for preserve tokens — the literal inner content
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    if (input[i] === "<") {
      // Comment
      if (input.startsWith("<!--", i)) {
        const end = input.indexOf("-->", i + 4);
        const stop = end === -1 ? n : end + 3;
        tokens.push({ type: "comment", raw: input.slice(i, stop) });
        i = stop;
        continue;
      }
      // Doctype / declaration
      if (input.startsWith("<!", i)) {
        const end = input.indexOf(">", i);
        const stop = end === -1 ? n : end + 1;
        tokens.push({ type: "doctype", raw: input.slice(i, stop) });
        i = stop;
        continue;
      }
      // Closing tag
      if (input.startsWith("</", i)) {
        const end = input.indexOf(">", i);
        const stop = end === -1 ? n : end + 1;
        const raw = input.slice(i, stop);
        const name = raw.slice(2, -1).trim().split(/\s+/)[0].toLowerCase();
        tokens.push({ type: "close", name, raw });
        i = stop;
        continue;
      }
      // Opening or self-closing tag
      const end = findTagEnd(input, i);
      if (end === -1) {
        // Unterminated tag, treat as text
        tokens.push({ type: "text", raw: input.slice(i) });
        break;
      }
      const raw = input.slice(i, end + 1);
      const inner = raw.slice(1, -1).trim();
      const name = inner.split(/\s+/)[0].toLowerCase().replace(/\/$/, "");
      const selfClosing = raw.endsWith("/>") || VOID_TAGS.has(name);
      i = end + 1;

      if (PRESERVE_TAGS.has(name) && !selfClosing) {
        // Capture everything verbatim until matching closing tag.
        const closeRe = new RegExp(`</${name}\\s*>`, "i");
        const rest = input.slice(i);
        const match = rest.match(closeRe);
        const stopIdx = match ? i + (match.index ?? 0) + match[0].length : n;
        const content = input.slice(i, match ? i + (match.index ?? 0) : n);
        const closeRaw = match ? match[0] : "";
        tokens.push({ type: "open", name, raw });
        tokens.push({ type: "preserve", raw: content, content });
        if (closeRaw) tokens.push({ type: "close", name, raw: closeRaw });
        i = stopIdx;
        continue;
      }

      tokens.push({ type: selfClosing ? "selfclose" : "open", name, raw });
      continue;
    }

    // Text node
    const next = input.indexOf("<", i);
    const stop = next === -1 ? n : next;
    const raw = input.slice(i, stop);
    if (raw.trim().length > 0 || raw.includes("\n")) {
      tokens.push({ type: "text", raw });
    }
    i = stop;
  }
  return tokens;
}

function findTagEnd(input: string, start: number): number {
  // Skip over quoted attribute values so a > inside an attribute doesn't end the tag.
  let i = start + 1;
  const n = input.length;
  let inStr: '"' | "'" | null = null;
  while (i < n) {
    const c = input[i];
    if (inStr) {
      if (c === inStr) inStr = null;
    } else {
      if (c === '"' || c === "'") inStr = c as '"' | "'";
      else if (c === ">") return i;
    }
    i++;
  }
  return -1;
}

export function formatHtml(input: string, indent = "  "): string {
  if (!input || !input.trim()) return input;

  // Quick guard: only format if it looks like HTML.
  if (!/[<][a-zA-Z!]/.test(input)) return input;

  const tokens = tokenize(input);
  const out: string[] = [];
  let depth = 0;
  const pad = (d: number) => indent.repeat(Math.max(0, d));

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === "doctype" || t.type === "comment") {
      out.push(pad(depth) + t.raw.trim());
      continue;
    }
    if (t.type === "open") {
      const name = t.name ?? "";
      // Inline tags don't push a new line on their own — but for safety we
      // still emit them on their own line; readability beats compactness here.
      out.push(pad(depth) + t.raw.trim());
      if (!INLINE_TAGS.has(name)) depth += 1;
      else depth += 1; // keep nesting visible
      continue;
    }
    if (t.type === "close") {
      depth = Math.max(0, depth - 1);
      out.push(pad(depth) + t.raw.trim());
      continue;
    }
    if (t.type === "selfclose") {
      out.push(pad(depth) + t.raw.trim());
      continue;
    }
    if (t.type === "preserve") {
      // Re-indent the preserved block by adding the current indent in front
      // of every non-empty line, preserving the inner structure.
      const lines = (t.content ?? "").split("\n");
      for (const ln of lines) out.push(pad(depth) + ln.replace(/^\s+/, ""));
      continue;
    }
    if (t.type === "text") {
      // HTML whitespace is non-significant outside <pre>/<script>/<style>
      // (which we already capture as preserve tokens), so collapse every
      // run of whitespace — including newlines — down to a single space.
      const cleaned = t.raw.replace(/\s+/g, " ").trim();
      if (!cleaned) continue;
      out.push(pad(depth) + cleaned);
      continue;
    }
  }

  // Drop blank lines (the preserve block is the only place that could emit
  // them, and email-template HTML reads better tightly packed).
  return out.filter((ln) => ln.trim().length > 0).join("\n");
}

/** Returns true if this filename should have HTML pretty-printing applied. */
export function shouldFormatAsHtml(filePath: string): boolean {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return true;
  // FR email templates store HTML bodies as .md files. We match any .md
  // because callers may pass a bare filename (no path segment) — formatHtml
  // is a no-op for content that doesn't contain HTML tags, so this is safe
  // for genuine markdown too.
  if (lower.endsWith(".md")) return true;
  return false;
}
