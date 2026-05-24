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
    "tests/integration/suite/envCrud.test.ts"
  ],
  bundle: false,
  outdir: "out/tests/integration",
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  logLevel: "info"
};

if (watch) {
  const ctx1 = await esbuild.context(extensionConfig);
  const ctx2 = await esbuild.context(integrationTestConfig);
  await Promise.all([ctx1.watch(), ctx2.watch()]);
  console.log("watching…");
} else {
  await esbuild.build(extensionConfig);
  await esbuild.build(integrationTestConfig);
}
