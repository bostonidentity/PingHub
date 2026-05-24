// aic-studio/scripts/stamp-insiders-version.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const baseVersion = pkg.version;
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const newVersion = `${baseVersion}-insiders.${stamp}`;

pkg.name = "aic-studio-insiders";
pkg.displayName = `${pkg.displayName} (Insiders)`;
pkg.version = newVersion;

writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`Stamped insiders version: ${newVersion}`);
