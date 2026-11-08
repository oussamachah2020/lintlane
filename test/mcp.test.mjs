import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { KIT_DIR, tempDir, write } from "./helpers.mjs";

async function connect(project, allowWrite = false) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      join(KIT_DIR, "bin/mcp.mjs"),
      "--project",
      project,
      ...(allowWrite ? ["--allow-write"] : []),
    ],
    stderr: "pipe",
  });
  const client = new Client({ name: "lintlane-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}
function project() {
  const dir = tempDir();
  write(
    dir,
    "package.json",
    JSON.stringify({ name: "mcp-test", scripts: { typecheck: 'node -e "console.log(42)"' } }),
  );
  write(dir, "biome.json", '{"formatter":{"indentStyle":"space"}}');
  write(dir, "a.js", "export const a=1\n");
  write(
    dir,
    "commitlint.config.mjs",
    `export { default } from ${JSON.stringify(join(KIT_DIR, "presets/commitlint.mjs"))};`,
  );
  return dir;
}

test("stdio MCP handshake, discovery, diagnostics, scripts, message validation, and write gating", async () => {
  const dir = project();
  const client = await connect(dir);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
    const call = (name, args = {}) => client.callTool({ name, arguments: args });
    const checks = await call("lintlane_checks");
    assert.equal(checks.structuredContent.allowWrite, false);
    assert.ok(checks.structuredContent.steps.some((step) => step.id === "typecheck"));
    const checked = await call("lintlane_check", { paths: ["a.js"] });
    assert.equal(checked.isError, true);
    assert.match(checked.structuredContent.stdout + checked.structuredContent.stderr, /a.js/);
    const original = readFileSync(join(dir, "a.js"), "utf8");
    const fix = await call("lintlane_fix", { paths: ["a.js"] });
    assert.equal(fix.isError, true);
    assert.match(fix.content[0].text, /disabled/);
    assert.equal(readFileSync(join(dir, "a.js"), "utf8"), original);
    const run = await call("lintlane_run", { checks: ["typecheck"] });
    assert.equal(run.isError, false);
    assert.match(run.structuredContent.stdout, /42/);
    assert.equal((await call("lintlane_run", { checks: ["install"] })).isError, true);
    assert.equal(
      (await call("lintlane_check_commit", { message: "feat: add MCP support" })).isError,
      false,
    );
    assert.equal((await call("lintlane_check_commit", { message: "bad message" })).isError, true);
    const doctor = await call("lintlane_doctor");
    assert.equal(doctor.structuredContent.report.ok, false);
    assert.ok(Array.isArray(doctor.structuredContent.report.findings));
    const preview = await call("lintlane_preview_setup");
    assert.equal(preview.structuredContent.timedOut, false);
  } finally {
    await client.close();
  }
});

test("write-enabled MCP applies real fixes and rejects escaping paths and symlinks", async () => {
  const dir = project();
  const outside = tempDir();
  write(outside, "outside.js", "const x=1\n");
  symlinkSync(join(outside, "outside.js"), join(dir, "escape.js"));
  const client = await connect(dir, true);
  try {
    const call = (name, paths) => client.callTool({ name, arguments: { paths } });
    for (const path of ["../", join(outside, "outside.js"), "escape.js"]) {
      const result = await call("lintlane_fix", [path]);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /inside/);
    }
    const fixed = await call("lintlane_fix", ["a.js"]);
    assert.equal(fixed.isError, false);
    assert.match(readFileSync(join(dir, "a.js"), "utf8"), /a = 1;/);
    assert.equal((await call("lintlane_check", ["a.js"])).isError, false);
    assert.equal(readFileSync(join(outside, "outside.js"), "utf8"), "const x=1\n");
  } finally {
    await client.close();
  }
});

test("MCP binary works through package-manager symlinks", () => {
  const dir = tempDir();
  const bin = join(dir, "lintlane-mcp");
  symlinkSync(join(KIT_DIR, "bin/mcp.mjs"), bin);
  const result = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: lintlane-mcp/);
});
