import esbuild from "esbuild";
import { argv } from "node:process";

const watch = argv.includes("--watch");
const production = !watch;

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "out/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode", "better-sqlite3"],
  sourcemap: !production,
  minify: production,
  logLevel: "info"
};

/** @type {import('esbuild').BuildOptions} */
const integrationTestConfig = {
  entryPoints: [
    "tests/integration/runTest.ts",
    "tests/integration/suite/index.ts",
    "tests/integration/suite/activation.test.ts",
    "tests/integration/suite/envCrud.test.ts",
    "tests/integration/suite/pullFlow.test.ts",
    "tests/integration/suite/virtualDocs.test.ts",
    "tests/integration/suite/compare.test.ts",
    "tests/integration/suite/pushFlow.test.ts",
    "tests/integration/suite/promoteFlow.test.ts",
    "tests/integration/suite/historyView.test.ts",
    "tests/integration/suite/compareExtras.test.ts",
    "tests/integration/suite/promotionTasksPolish.test.ts",
    "tests/integration/suite/federation.test.ts",
    "tests/integration/suite/monitors.test.ts",
    "tests/integration/suite/logs.test.ts"
  ],
  bundle: false,
  outdir: "out/tests/integration",
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  logLevel: "info"
};

/** @type {import('esbuild').BuildOptions} */
const webviewUiConfig = {
  entryPoints: [
    "src/webviews/ui/federation-editor/main.tsx",
    "src/webviews/ui/monitor-dashboard/main.tsx",
    "src/webviews/ui/logs-query/main.tsx"
  ],
  bundle: true,
  outdir: "out/webviews",
  outbase: "src/webviews/ui",
  entryNames: "[dir]/main",
  platform: "browser",
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
  loader: { ".css": "css" }
};

if (watch) {
  const ctx1 = await esbuild.context(extensionConfig);
  const ctx2 = await esbuild.context(integrationTestConfig);
  const ctx3 = await esbuild.context(webviewUiConfig);
  await Promise.all([ctx1.watch(), ctx2.watch(), ctx3.watch()]);
  console.log("watching…");
} else {
  await esbuild.build(extensionConfig);
  await esbuild.build(integrationTestConfig);
  await esbuild.build(webviewUiConfig);
}
