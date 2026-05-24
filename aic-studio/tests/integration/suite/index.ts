// tests/integration/suite/index.ts
import * as path from "node:path";
import { glob } from "glob";
import Mocha from "mocha";

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "bdd", color: true, timeout: 60_000 });
  const testsRoot = __dirname;
  const files = await glob("**/*.test.js", { cwd: testsRoot });
  for (const f of files) mocha.addFile(path.resolve(testsRoot, f));
  await new Promise<void>((resolve, reject) => {
    mocha.run((failures) => failures > 0 ? reject(new Error(`${failures} test(s) failed`)) : resolve());
  });
}
