// Lazy Prettier loader + formatter. Kept in its own module so the standalone
// bundle (~300 KB gzipped) only downloads the first time the user toggles the
// Format button in the script viewer.

type Plugin = object;
type FormatOptions = Record<string, unknown> & { parser: string; plugins: Plugin[] };
type FormatFn = (code: string, opts: FormatOptions) => Promise<string>;

let cached: Promise<{ format: FormatFn; plugins: Plugin[] }> | null = null;

function loadPrettier() {
  if (cached) return cached;
  cached = (async () => {
    const [std, babel, estree] = await Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/babel"),
      import("prettier/plugins/estree"),
    ]);
    return {
      format: std.format as unknown as FormatFn,
      plugins: [babel as unknown as Plugin, estree as unknown as Plugin],
    };
  })();
  return cached;
}

/**
 * Prettier options applied to every JS/Groovy format call. Mirrors the
 * team's project-wide .prettierrc so output inside the script viewer
 * matches what a local `prettier --write` would produce.
 */
const PRETTIER_OPTIONS: Omit<FormatOptions, "parser" | "plugins"> = {
  arrowParens: "always",
  bracketSameLine: false,
  objectWrap: "preserve",
  bracketSpacing: true,
  semi: true,
  experimentalOperatorPosition: "end",
  experimentalTernaries: false,
  singleQuote: false,
  jsxSingleQuote: false,
  quoteProps: "as-needed",
  trailingComma: "all",
  singleAttributePerLine: false,
  htmlWhitespaceSensitivity: "css",
  vueIndentScriptAndStyle: false,
  proseWrap: "preserve",
  endOfLine: "lf",
  insertPragma: false,
  printWidth: 80,
  requirePragma: false,
  tabWidth: 2,
  useTabs: false,
  embeddedLanguageFormatting: "auto",
};

/** Format a JavaScript string with Prettier. Returns the original code on failure. */
export async function formatJavaScript(code: string): Promise<{ text: string; error?: string }> {
  try {
    const { format, plugins } = await loadPrettier();
    const text = await format(code, { parser: "babel", plugins, ...PRETTIER_OPTIONS });
    return { text };
  } catch (err) {
    return { text: code, error: err instanceof Error ? err.message : String(err) };
  }
}
