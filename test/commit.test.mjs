import assert from "node:assert/strict";
import { test } from "node:test";
import { gitOut, read, runCli, tempDir, write } from "./helpers.mjs";

for (const source of ["package.json", ".czrc", ".cz.json"]) {
  test(`commit resolves the bundled adapter from ${source}`, () => {
    const cwd = tempDir();
    gitOut(cwd, "init", "-q");
    const config = { path: "lintlane/presets/commitizen.cjs" };
    write(
      cwd,
      "package.json",
      JSON.stringify({
        name: "app",
        config: source === "package.json" ? { commitizen: config } : {},
      }),
    );
    if (source !== "package.json") write(cwd, source, JSON.stringify(config));
    const result = runCli(["commit"], { cwd });
    assert.match(result.stderr, /No files added to staging/, result.stderr);
    assert.doesNotMatch(result.stderr, /Could not resolve|Cannot find module/);
    assert.equal(
      JSON.parse(read(cwd, source)).path ?? JSON.parse(read(cwd, source)).config.commitizen.path,
      config.path,
    );
  });
}

test("commit preserves a custom adapter and forwards git arguments", () => {
  const cwd = tempDir();
  gitOut(cwd, "init", "-q");
  write(
    cwd,
    "package.json",
    JSON.stringify({ name: "app", config: { commitizen: { path: "./adapter.cjs" } } }),
  );
  write(
    cwd,
    "adapter.cjs",
    'throw new Error("custom adapter: " + JSON.stringify(process.argv.slice(2)));\n',
  );
  gitOut(cwd, "add", ".");
  const result = runCli(["commit", "--", "--no-verify"], { cwd });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /custom adapter: \["--","--no-verify"\]/);
});
