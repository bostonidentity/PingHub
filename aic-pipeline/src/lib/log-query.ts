// Tiny boolean-query parser for the logs Filter and Highlight boxes.
//
// Grammar:
//   expr   := or
//   or     := and ( '||' and )*
//   and    := atom ( '&&'? atom )*       // whitespace between atoms = implicit AND
//   atom   := '(' expr ')'
//          | '"' chars '"'              // exact substring (matchCase / wholeWord apply)
//          | bareword                   // any run of non-whitespace, non-operator chars
//
// Notes:
// - Operators must be `&&` and `||` (single `&` or `|` is a literal char in a bareword).
// - Whitespace is insignificant outside quoted strings; juxtaposed atoms are AND-ed
//   together, so `foo bar baz` is the same as `foo && bar && baz`.
// - Comma is treated as `||` for backwards compatibility with the existing
//   comma-separated highlight box (`auth, login` ≡ `auth || login`).

export interface QueryOptions {
    matchCase: boolean;
    wholeWord: boolean;
}

export interface ParsedQuery {
    /** Tests whether `haystack` satisfies the query. */
    test: (haystack: string) => boolean;
    /** Positive leaf terms (for per-token <mark> rendering). De-duplicated, original case. */
    highlightTerms: string[];
    /** Parse error message, if any. When set, `test` always returns `false`. */
    error?: string;
    /** True if the source had no terms (whitespace-only). `test` returns `true`. */
    empty: boolean;
}

const MAX_LEN = 2048;
const MAX_DEPTH = 32;

interface Token {
    kind: "AND" | "OR" | "LP" | "RP" | "TERM";
    value: string; // raw term text for TERM, otherwise operator literal
    pos: number;   // start offset in source
}

function tokenize(src: string): { tokens: Token[]; error?: string } {
    const tokens: Token[] = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
        if (ch === "(") { tokens.push({ kind: "LP", value: "(", pos: i }); i++; continue; }
        if (ch === ")") { tokens.push({ kind: "RP", value: ")", pos: i }); i++; continue; }
        if (ch === "&" && src[i + 1] === "&") {
            tokens.push({ kind: "AND", value: "&&", pos: i }); i += 2; continue;
        }
        if (ch === "|" && src[i + 1] === "|") {
            tokens.push({ kind: "OR", value: "||", pos: i }); i += 2; continue;
        }
        if (ch === ",") {
            // Backwards-compat alias for ||
            tokens.push({ kind: "OR", value: ",", pos: i }); i++; continue;
        }
        if (ch === '"') {
            const start = i;
            i++;
            let value = "";
            while (i < src.length && src[i] !== '"') {
                if (src[i] === "\\" && i + 1 < src.length) {
                    // Allow simple \" and \\ escapes inside quoted terms.
                    const next = src[i + 1];
                    if (next === '"' || next === "\\") { value += next; i += 2; continue; }
                }
                value += src[i]; i++;
            }
            if (i >= src.length) {
                return { tokens, error: `Unterminated quoted string at position ${start + 1}` };
            }
            i++; // consume closing quote
            tokens.push({ kind: "TERM", value, pos: start });
            continue;
        }
        // Bareword: any run of chars that aren't whitespace, parens, operator pairs, or quote.
        const start = i;
        let value = "";
        while (i < src.length) {
            const c = src[i];
            if (c === " " || c === "\t" || c === "\n" || c === "\r") break;
            if (c === "(" || c === ")" || c === '"' || c === ",") break;
            if (c === "&" && src[i + 1] === "&") break;
            if (c === "|" && src[i + 1] === "|") break;
            value += c; i++;
        }
        if (value.length === 0) {
            return { tokens, error: `Unexpected character '${ch}' at position ${start + 1}` };
        }
        tokens.push({ kind: "TERM", value, pos: start });
    }
    return { tokens };
}

interface Node {
    kind: "and" | "or" | "term";
    children?: Node[];
    value?: string;
}

interface ParserState { i: number; tokens: Token[]; depth: number; error?: string }

function parseExpr(s: ParserState): Node | null {
    return parseOr(s);
}

function parseOr(s: ParserState): Node | null {
    let left = parseAnd(s);
    if (left == null) return null;
    const items: Node[] = [left];
    while (s.i < s.tokens.length && s.tokens[s.i].kind === "OR") {
        s.i++;
        const right = parseAnd(s);
        if (right == null) return null;
        items.push(right);
    }
    if (items.length === 1) return left;
    return { kind: "or", children: items };
}

function parseAnd(s: ParserState): Node | null {
    const left = parseAtom(s);
    if (left == null) return null;
    const items: Node[] = [left];
    // Accept either an explicit '&&' or an implicit AND (the next token is another
    // atom — a TERM or '('). '||' and ')' end the AND chain.
    while (s.i < s.tokens.length) {
        const tok = s.tokens[s.i];
        if (tok.kind === "AND") {
            s.i++;
            const right = parseAtom(s);
            if (right == null) return null;
            items.push(right);
            continue;
        }
        if (tok.kind === "TERM" || tok.kind === "LP") {
            const right = parseAtom(s);
            if (right == null) return null;
            items.push(right);
            continue;
        }
        break;
    }
    if (items.length === 1) return left;
    return { kind: "and", children: items };
}

function parseAtom(s: ParserState): Node | null {
    const tok = s.tokens[s.i];
    if (!tok) {
        s.error = "Unexpected end of expression";
        return null;
    }
    if (tok.kind === "LP") {
        if (s.depth >= MAX_DEPTH) {
            s.error = `Expression nested too deeply (max ${MAX_DEPTH})`;
            return null;
        }
        s.i++;
        s.depth++;
        const inner = parseExpr(s);
        s.depth--;
        if (inner == null) return null;
        const close = s.tokens[s.i];
        if (!close || close.kind !== "RP") {
            s.error = `Missing ')' at position ${(close?.pos ?? tok.pos) + 1}`;
            return null;
        }
        s.i++;
        return inner;
    }
    if (tok.kind === "TERM") {
        s.i++;
        return { kind: "term", value: tok.value };
    }
    s.error = `Unexpected '${tok.value}' at position ${tok.pos + 1}`;
    return null;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPredicate(term: string, opts: QueryOptions): (h: string) => boolean {
    if (opts.wholeWord) {
        const re = new RegExp(`\\b${escapeRegex(term)}\\b`, opts.matchCase ? "" : "i");
        return (h) => re.test(h);
    }
    if (opts.matchCase) return (h) => h.includes(term);
    const lower = term.toLowerCase();
    return (h) => h.toLowerCase().includes(lower);
}

function compile(node: Node, opts: QueryOptions): (h: string) => boolean {
    if (node.kind === "term") return termPredicate(node.value!, opts);
    const children = node.children!.map((c) => compile(c, opts));
    if (node.kind === "and") return (h) => children.every((p) => p(h));
    return (h) => children.some((p) => p(h));
}

function collectTerms(node: Node, out: string[]) {
    if (node.kind === "term") { out.push(node.value!); return; }
    for (const c of node.children!) collectTerms(c, out);
}

export function parseQuery(src: string, opts: QueryOptions): ParsedQuery {
    const trimmed = src.trim();
    if (trimmed.length === 0) {
        return { test: () => true, highlightTerms: [], empty: true };
    }
    if (src.length > MAX_LEN) {
        return {
            test: () => false,
            highlightTerms: [],
            empty: false,
            error: `Query too long (${src.length} chars; max ${MAX_LEN})`,
        };
    }
    const { tokens, error: lexErr } = tokenize(src);
    if (lexErr) {
        return { test: () => false, highlightTerms: [], empty: false, error: lexErr };
    }
    if (tokens.length === 0) {
        return { test: () => true, highlightTerms: [], empty: true };
    }
    const state: ParserState = { i: 0, tokens, depth: 0 };
    const tree = parseExpr(state);
    if (!tree) {
        return { test: () => false, highlightTerms: [], empty: false, error: state.error ?? "Parse error" };
    }
    if (state.i < tokens.length) {
        const tok = tokens[state.i];
        return {
            test: () => false,
            highlightTerms: [],
            empty: false,
            error: `Unexpected '${tok.value}' at position ${tok.pos + 1}`,
        };
    }
    const test = compile(tree, opts);
    const terms: string[] = [];
    collectTerms(tree, terms);
    // De-duplicate while preserving order (case-sensitive — display still uses original).
    const seen = new Set<string>();
    const highlightTerms = terms.filter((t) => (seen.has(t) ? false : (seen.add(t), true)));
    return { test, highlightTerms, empty: false };
}
