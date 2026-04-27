import { describe, expect, it } from "vitest";
import { parseQuery } from "./log-query";

const ci = { matchCase: false, wholeWord: false };
const cs = { matchCase: true, wholeWord: false };
const ww = { matchCase: false, wholeWord: true };

describe("log-query", () => {
  describe("empty / trivial", () => {
    it("treats empty input as match-all", () => {
      const q = parseQuery("", ci);
      expect(q.empty).toBe(true);
      expect(q.error).toBeUndefined();
      expect(q.test("anything")).toBe(true);
      expect(q.test("")).toBe(true);
      expect(q.highlightTerms).toEqual([]);
    });

    it("treats whitespace-only input as match-all", () => {
      const q = parseQuery("   \t\n", ci);
      expect(q.empty).toBe(true);
      expect(q.test("foo")).toBe(true);
    });

    it("matches a single bareword (case-insensitive)", () => {
      const q = parseQuery("error", ci);
      expect(q.test("an ERROR happened")).toBe(true);
      expect(q.test("all good")).toBe(false);
      expect(q.highlightTerms).toEqual(["error"]);
    });

    it("matches a single bareword (case-sensitive)", () => {
      const q = parseQuery("Error", cs);
      expect(q.test("an Error happened")).toBe(true);
      expect(q.test("an error happened")).toBe(false);
    });
  });

  describe("&& operator", () => {
    it("requires all terms", () => {
      const q = parseQuery("error && timeout", ci);
      expect(q.test("error: connection timeout")).toBe(true);
      expect(q.test("error: bad request")).toBe(false);
      expect(q.test("plain timeout")).toBe(false);
      expect(q.highlightTerms).toEqual(["error", "timeout"]);
    });

    it("chains arbitrarily", () => {
      const q = parseQuery("a && b && c && d", ci);
      expect(q.test("d c b a")).toBe(true);
      expect(q.test("a b c")).toBe(false);
    });
  });

  describe("|| operator", () => {
    it("matches any term", () => {
      const q = parseQuery("error || warn", ci);
      expect(q.test("ERROR happened")).toBe(true);
      expect(q.test("a WARN here")).toBe(true);
      expect(q.test("info only")).toBe(false);
    });

    it("treats comma as ||", () => {
      const q = parseQuery("auth, login, signup", ci);
      expect(q.test("user signup ok")).toBe(true);
      expect(q.test("auth complete")).toBe(true);
      expect(q.test("logout")).toBe(false);
    });

    it("allows mixing comma and ||", () => {
      const q = parseQuery("a, b || c", ci);
      expect(q.test("only a")).toBe(true);
      expect(q.test("only b")).toBe(true);
      expect(q.test("only c")).toBe(true);
      expect(q.test("nothing")).toBe(false);
    });
  });

  describe("precedence", () => {
    it("&& binds tighter than ||", () => {
      const q = parseQuery("a || b && c", ci);
      // Equivalent to: a || (b && c)
      expect(q.test("a only")).toBe(true);
      expect(q.test("b and c together")).toBe(true);
      expect(q.test("only b")).toBe(false);
      expect(q.test("only c")).toBe(false);
    });

    it("respects explicit parentheses", () => {
      const q = parseQuery("(a || b) && c", ci);
      expect(q.test("a c")).toBe(true);
      expect(q.test("b c")).toBe(true);
      expect(q.test("a only")).toBe(false);
      expect(q.test("c only")).toBe(false);
    });

    it("supports nested parentheses", () => {
      const q = parseQuery("((a || b) && (c || d)) && e", ci);
      expect(q.test("a c e")).toBe(true);
      expect(q.test("b d e")).toBe(true);
      expect(q.test("a c")).toBe(false);
      expect(q.test("a e")).toBe(false);
    });

    it("redundant parens are no-ops", () => {
      const q = parseQuery("(((foo)))", ci);
      expect(q.test("foo here")).toBe(true);
      expect(q.test("bar")).toBe(false);
    });
  });

  describe("quoted strings", () => {
    it("treats quoted text as a literal substring", () => {
      const q = parseQuery('"a && b"', ci);
      expect(q.test("x a && b y")).toBe(true);
      expect(q.test("a or b")).toBe(false);
    });

    it("preserves spaces inside quotes", () => {
      const q = parseQuery('"hello world"', ci);
      expect(q.test("say hello world today")).toBe(true);
      expect(q.test("hello there world")).toBe(false);
    });

    it("supports escaped quotes inside quoted terms", () => {
      const q = parseQuery('"say \\"hi\\""', ci);
      expect(q.test('user said: say "hi" politely')).toBe(true);
      expect(q.test('user said hi politely')).toBe(false);
      expect(q.highlightTerms).toEqual(['say "hi"']);
    });

    it("composes with operators", () => {
      const q = parseQuery('"foo bar" && baz', ci);
      expect(q.test("xx foo bar yy baz")).toBe(true);
      expect(q.test("foo bar without")).toBe(false);
    });
  });

  describe("whole-word option", () => {
    it("only matches whole words", () => {
      const q = parseQuery("err", ww);
      expect(q.test("an err here")).toBe(true);
      expect(q.test("an error here")).toBe(false);
    });

    it("applies to each leaf in a compound query", () => {
      const q = parseQuery("err && info", ww);
      expect(q.test("err and info")).toBe(true);
      expect(q.test("error and info")).toBe(false);
    });
  });

  describe("highlightTerms", () => {
    it("collects all leaf terms", () => {
      const q = parseQuery("(a || b) && c", ci);
      expect(q.highlightTerms).toEqual(["a", "b", "c"]);
    });

    it("de-duplicates while preserving order", () => {
      const q = parseQuery("a && b && a && c && b", ci);
      expect(q.highlightTerms).toEqual(["a", "b", "c"]);
    });

    it("preserves quoted-term spacing", () => {
      const q = parseQuery('"foo bar" || baz', ci);
      expect(q.highlightTerms).toEqual(["foo bar", "baz"]);
    });
  });

  describe("edge characters in barewords", () => {
    it("allows single & and | as part of a term", () => {
      const q = parseQuery("a&b", ci);
      expect(q.test("contains a&b literal")).toBe(true);
      expect(q.test("a only")).toBe(false);
    });

    it("allows special regex chars without escaping", () => {
      const q = parseQuery("/api/v1.0", ci);
      expect(q.test("GET /api/v1.0/users")).toBe(true);
      expect(q.test("/api/v100/users")).toBe(false); // '.' is literal
    });

    it("allows a term with embedded slashes/colons", () => {
      const q = parseQuery("https://example.com:8080/path", ci);
      expect(q.test("see https://example.com:8080/path here")).toBe(true);
    });
  });

  describe("parse errors", () => {
    it("flags unmatched opening paren", () => {
      const q = parseQuery("(a && b", ci);
      expect(q.error).toBeDefined();
      expect(q.test("a b")).toBe(false);
    });

    it("flags unmatched closing paren", () => {
      const q = parseQuery("a)", ci);
      expect(q.error).toBeDefined();
    });

    it("flags trailing operator", () => {
      const q = parseQuery("a &&", ci);
      expect(q.error).toBeDefined();
    });

    it("flags leading operator", () => {
      const q = parseQuery("|| a", ci);
      expect(q.error).toBeDefined();
    });

    it("flags consecutive operators", () => {
      const q = parseQuery("a && && b", ci);
      expect(q.error).toBeDefined();
    });

    it("flags empty parens", () => {
      const q = parseQuery("()", ci);
      expect(q.error).toBeDefined();
    });

    it("flags unterminated quoted string", () => {
      const q = parseQuery('"foo', ci);
      expect(q.error).toBeDefined();
      expect(q.error).toMatch(/Unterminated/);
    });

    it("flags implicit AND (juxtaposed terms)", () => {
      const q = parseQuery("foo bar", ci);
      expect(q.error).toBeDefined();
    });

    it("flags too-deep nesting", () => {
      const deep = "(".repeat(40) + "x" + ")".repeat(40);
      const q = parseQuery(deep, ci);
      expect(q.error).toBeDefined();
      expect(q.error).toMatch(/deeply/);
    });

    it("flags too-long input", () => {
      const long = "a".repeat(3000);
      const q = parseQuery(long, ci);
      expect(q.error).toBeDefined();
      expect(q.error).toMatch(/too long/);
    });
  });

  describe("realistic log queries", () => {
    const line =
      '2026-04-27T10:00:00Z am-everything ERROR auth/login failed user=alice tenant=acme';

    it("AND combination of fields", () => {
      const q = parseQuery("ERROR && alice", ci);
      expect(q.test(line)).toBe(true);
    });

    it("OR-of-ANDs", () => {
      const q = parseQuery("(ERROR && alice) || (WARN && bob)", ci);
      expect(q.test(line)).toBe(true);
      expect(q.test("WARN bob session")).toBe(true);
      expect(q.test("INFO carol")).toBe(false);
    });

    it("phrase + level", () => {
      const q = parseQuery('ERROR && "auth/login"', ci);
      expect(q.test(line)).toBe(true);
      expect(q.test("ERROR auth login")).toBe(false);
    });
  });
});
