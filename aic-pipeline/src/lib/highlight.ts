// ── Shared syntax highlighters (no external dependencies) ────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── JavaScript / Groovy ──────────────────────────────────────────────────────

const JS_KEYWORDS = new Set([
  "var","let","const","function","return","if","else","for","while","do",
  "switch","case","break","continue","new","delete","typeof","instanceof",
  "in","of","class","extends","import","export","default","try","catch",
  "finally","throw","async","await","yield","this","super","static",
]);
const JS_BUILTINS = new Set(["true","false","null","undefined","NaN","Infinity"]);

// Keywords after which a following `/` starts a regex literal rather than
// a division operator. Identifier/number/`)`/`]`/`}` contexts mean division.
const REGEX_CONTEXT_KEYWORDS = new Set([
  "return","typeof","delete","void","new","in","of","instanceof",
  "throw","case","yield","await","else","do",
]);

/**
 * Parse a JS regex literal starting at `code[i]` (which must be `/`). Returns
 * the sliced text and the index just after it, or null if the token doesn't
 * terminate on the same line (unterminated — treat as division to avoid
 * swallowing the rest of the file).
 */
function parseRegexLiteral(code: string, i: number): { text: string; end: number } | null {
  let j = i + 1;
  let inClass = false;
  while (j < code.length) {
    const c = code[j];
    if (c === "\n") return null;
    if (c === "\\") { j += 2; continue; }
    if (c === "[") { inClass = true; j++; continue; }
    if (c === "]" && inClass) { inClass = false; j++; continue; }
    if (c === "/" && !inClass) {
      j++;
      while (j < code.length && /[gimsuy]/.test(code[j])) j++;
      return { text: code.slice(i, j), end: j };
    }
    j++;
  }
  return null;
}

export function highlightJs(code: string): string {
  const out: string[] = [];
  let i = 0;
  let canBeRegex = true;

  function span(color: string, text: string, bold = false) {
    return `<span style="color:${color}${bold ? ";font-weight:500" : ""}">${esc(text)}</span>`;
  }

  while (i < code.length) {
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      const text = end === -1 ? code.slice(i) : code.slice(i, end);
      out.push(span("#6b7280", text));
      i += text.length;
    } else if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const text = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      out.push(span("#6b7280", text));
      i += text.length;
    } else if (c === "/" && canBeRegex) {
      const re = parseRegexLiteral(code, i);
      if (re) {
        out.push(span("#f59e0b", re.text));
        i = re.end;
        canBeRegex = false;
        continue;
      }
      out.push(esc(c));
      i++;
      canBeRegex = true;
    } else if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let j = i + 1;
      while (j < code.length && code[j] !== q) {
        if (code[j] === "\\") j++;
        j++;
      }
      out.push(span("#86efac", code.slice(i, j + 1)));
      i = j + 1;
      canBeRegex = false;
    } else if (/[a-zA-Z_$]/.test(c)) {
      let j = i + 1;
      while (j < code.length && /[a-zA-Z0-9_$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      if (JS_KEYWORDS.has(word))      out.push(span("#c084fc", word, true));
      else if (JS_BUILTINS.has(word)) out.push(span("#f87171", word));
      else                            out.push(esc(word));
      i = j;
      canBeRegex = REGEX_CONTEXT_KEYWORDS.has(word);
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < code.length && /[0-9._xXeEbBoO]/.test(code[j])) j++;
      out.push(span("#fbbf24", code.slice(i, j)));
      i = j;
      canBeRegex = false;
    } else {
      out.push(esc(c));
      i++;
      if (c === ")" || c === "]" || c === "}") canBeRegex = false;
      else if (!/\s/.test(c)) canBeRegex = true;
    }
  }
  return out.join("");
}

// ── JSON ─────────────────────────────────────────────────────────────────────

export function highlightJson(raw: string): string {
  let formatted = raw;
  try { formatted = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* use raw */ }

  return formatted
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let color = "#60a5fa";
        if (/^"/.test(match)) {
          color = /:$/.test(match) ? "#94a3b8" : "#86efac";
        } else if (/true|false/.test(match)) {
          color = "#fbbf24";
        } else if (/null/.test(match)) {
          color = "#f87171";
        }
        return `<span style="color:${color}">${match}</span>`;
      }
    );
}

// ── Auto-detect and highlight ────────────────────────────────────────────────

export function highlight(content: string, language: string): string {
  if (language === "json") return highlightJson(content);
  if (language === "javascript" || language === "groovy") return highlightJs(content);
  return esc(content);
}

// ── Line-numbered wrapper ───────────────────────────────────────────────────

/** Wrap highlighted HTML with line numbers using a two-column table layout. */
export function withLineNumbers(highlightedHtml: string): string {
  const lines = highlightedHtml.split("\n");
  // If the last line is empty (trailing newline), drop it
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const gutterWidth = String(lines.length).length;
  return lines
    .map(
      (line, i) =>
        `<span style="display:inline-block;width:${gutterWidth + 1}ch;text-align:right;padding-right:1.5ch;margin-right:1ch;border-right:1px solid #334155;color:#64748b;user-select:none">${i + 1}</span>${line}`,
    )
    .join("\n");
}

// ── Token-based variants (React-safe, no innerHTML) ─────────────────────────

export interface HighlightToken {
  text: string;
  color?: string;
  bold?: boolean;
}

// Color palette — kept as named constants so highlightJs and highlightJsTokens
// stay in sync if one changes. Rough scheme: cool hues for structural tokens,
// warm hues for values/literals.
const C_COMMENT  = "#6b7280";
const C_KEYWORD  = "#c084fc";
const C_BUILTIN  = "#f87171";
const C_STRING   = "#86efac";
const C_NUMBER   = "#fbbf24";
const C_REGEX    = "#f59e0b";
const C_FN_CALL  = "#38bdf8";
const C_PROPERTY = "#22d3ee";
const C_OPERATOR = "#94a3b8";
const C_PUNCT    = "#64748b";
const C_INTERP   = "#fb923c";

// Characters that form (possibly multi-char) operators when clustered.
// `.` is excluded — treated as punctuation — so `a?.b` renders as `?` op + `.` punct.
const OP_CHARS = /[=+\-*/%<>!&|^~?:]/;
const PUNCT_CHARS = /[()[\]{},;.]/;

// Tokenize the expression body inside a `${ ... }` template interpolation,
// tracking balanced braces and respecting nested strings/regex/comments so
// a `}` inside a nested string or regex doesn't close the interpolation early.
function findTemplateExprEnd(code: string, start: number): number {
  let i = start;
  let depth = 1;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < code.length && code[j] !== q) { if (code[j] === "\\") j++; j++; }
      i = j + 1; continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== "`") {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === "$" && code[j + 1] === "{") { j = findTemplateExprEnd(code, j + 2) + 1; continue; }
        j++;
      }
      i = j + 1; continue;
    }
    if (c === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      i = end === -1 ? code.length : end; continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2; continue;
    }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") { depth--; if (depth === 0) return i; i++; continue; }
    i++;
  }
  return code.length;
}

export function highlightJsTokens(code: string): HighlightToken[] {
  const out: HighlightToken[] = [];
  let i = 0;
  // Regex context tracker — see parseRegexLiteral comment above.
  let canBeRegex = true;
  // Last emitted meaningful character (skipping whitespace) — lets us colour
  // identifiers as property access when preceded by `.`.
  let lastNonWsChar = "";

  const pushTok = (text: string, color?: string, bold?: boolean) => {
    out.push({ text, color, bold });
  };

  // Peek forward past whitespace/line comments from `from` and return the first
  // significant character (or "" at EOF). Used to decide if an identifier is a
  // call target.
  const peekNonWs = (from: number): string => {
    let k = from;
    while (k < code.length && /\s/.test(code[k])) k++;
    return code[k] ?? "";
  };

  while (i < code.length) {
    const c = code[i];

    // Line comment
    if (c === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      const text = end === -1 ? code.slice(i) : code.slice(i, end);
      pushTok(text, C_COMMENT);
      i += text.length;
      continue;
    }
    // Block comment
    if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const text = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      pushTok(text, C_COMMENT);
      i += text.length;
      continue;
    }
    // Regex literal
    if (c === "/" && canBeRegex) {
      const re = parseRegexLiteral(code, i);
      if (re) {
        pushTok(re.text, C_REGEX);
        i = re.end;
        canBeRegex = false;
        lastNonWsChar = "/";
        continue;
      }
    }
    // Template literal — tokenize string segments + recurse into `${...}`
    if (c === "`") {
      pushTok("`", C_STRING);
      i++;
      let chunk = "";
      while (i < code.length) {
        const ch = code[i];
        if (ch === "\\" && i + 1 < code.length) {
          chunk += code.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === "`") {
          if (chunk) pushTok(chunk, C_STRING);
          pushTok("`", C_STRING);
          i++;
          break;
        }
        if (ch === "$" && code[i + 1] === "{") {
          if (chunk) { pushTok(chunk, C_STRING); chunk = ""; }
          pushTok("${", C_INTERP);
          const exprEnd = findTemplateExprEnd(code, i + 2);
          const exprText = code.slice(i + 2, exprEnd);
          for (const t of highlightJsTokens(exprText)) out.push(t);
          pushTok("}", C_INTERP);
          i = exprEnd + 1;
          continue;
        }
        chunk += ch;
        i++;
      }
      canBeRegex = false;
      lastNonWsChar = "`";
      continue;
    }
    // Plain string
    if (c === '"' || c === "'") {
      const q = c;
      let j = i + 1;
      while (j < code.length && code[j] !== q) { if (code[j] === "\\") j++; j++; }
      pushTok(code.slice(i, j + 1), C_STRING);
      i = j + 1;
      canBeRegex = false;
      lastNonWsChar = q;
      continue;
    }
    // Identifier / keyword / builtin / property / function call
    if (/[a-zA-Z_$]/.test(c)) {
      let j = i + 1;
      while (j < code.length && /[a-zA-Z0-9_$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      if (JS_KEYWORDS.has(word)) {
        pushTok(word, C_KEYWORD, true);
      } else if (JS_BUILTINS.has(word)) {
        pushTok(word, C_BUILTIN);
      } else if (peekNonWs(j) === "(") {
        pushTok(word, C_FN_CALL);
      } else if (lastNonWsChar === ".") {
        pushTok(word, C_PROPERTY);
      } else {
        pushTok(word);
      }
      i = j;
      canBeRegex = REGEX_CONTEXT_KEYWORDS.has(word);
      lastNonWsChar = word[word.length - 1];
      continue;
    }
    // Number
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < code.length && /[0-9._xXeEbBoO]/.test(code[j])) j++;
      pushTok(code.slice(i, j), C_NUMBER);
      i = j;
      canBeRegex = false;
      lastNonWsChar = code[j - 1];
      continue;
    }
    // Operator (possibly multi-char)
    if (OP_CHARS.test(c)) {
      let j = i + 1;
      while (j < code.length && OP_CHARS.test(code[j])) j++;
      pushTok(code.slice(i, j), C_OPERATOR);
      i = j;
      canBeRegex = true;
      lastNonWsChar = code[j - 1];
      continue;
    }
    // Punctuation
    if (PUNCT_CHARS.test(c)) {
      pushTok(c, C_PUNCT);
      if (c === ")" || c === "]" || c === "}") canBeRegex = false;
      else canBeRegex = true;
      lastNonWsChar = c;
      i++;
      continue;
    }
    // Whitespace and anything else — keep uncoloured so the row reflows naturally.
    pushTok(c);
    if (!/\s/.test(c)) lastNonWsChar = c;
    i++;
  }

  return out;
}

export function highlightJsonTokens(raw: string): HighlightToken[] {
  let formatted = raw;
  try { formatted = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* use raw */ }
  const out: HighlightToken[] = [];
  // Split into tokens via matchAll to avoid stateful regex APIs.
  const re = /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  for (const m of formatted.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ text: formatted.slice(last, idx) });
    const match = m[0];
    let color = "#60a5fa";
    if (match.startsWith('"')) color = match.trimEnd().endsWith(":") ? "#94a3b8" : "#86efac";
    else if (match === "true" || match === "false") color = "#fbbf24";
    else if (match === "null") color = "#f87171";
    out.push({ text: match, color });
    last = idx + match.length;
  }
  if (last < formatted.length) out.push({ text: formatted.slice(last) });
  return out;
}

export function highlightTokens(content: string, language: string): HighlightToken[] {
  if (language === "json") return highlightJsonTokens(content);
  if (language === "javascript" || language === "groovy" || language === "js") return highlightJsTokens(content);
  return [{ text: content }];
}
