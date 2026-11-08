// One list of checks drives the CLI (`lintlane run`), the dashboard and the CI workflow.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveChecks } from "../bin/checks.mjs";
import { renderWorkflow } from "../bin/project.mjs";
import { gitOut, runCli, tempDir, write } from "./helpers.mjs";

const biome = ["/x/biome"];
const resolve = (pkg, pmName = "npm") => resolveChecks({ cwd: tempDir(), biome, pmName, pkg });
const ids = (result) => result.steps.map((step) => step.id);

describe("resolveChecks", () => {
  it("detects checks from package.json scripts", () => {
    const { steps, problems } = resolve({
      scripts: { typecheck: "tsc", build: "vite build", test: "vitest" },
    });
    assert.deepEqual(ids({ steps }), ["install", "biome", "typecheck", "build", "test"]);
    assert.deepEqual(problems, []);
    assert.equal(steps.find((s) => s.id === "install").defaultOn, false);
    assert.equal(steps.find((s) => s.id === "install").ci, false);
  });

  it("ignores npm's placeholder test script", () => {
    const result = resolve({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
    assert.ok(!ids(result).includes("test"));
  });

  it("lets package.json turn checks off and pick scripts", () => {
    const result = resolve({
      scripts: { build: "b", test: "t", "test:unit": "u" },
      lintlane: { checks: { build: false, test: "test:unit" } },
    });
    assert.ok(!ids(result).includes("build"));
    const test = result.steps.find((s) => s.id === "test");
    assert.deepEqual(test.cmd, ["npm", "run", "test:unit"]);
    assert.equal(test.script, "test:unit");
  });

  it("reports bad config instead of crashing or running unknown things", () => {
    const { steps, problems } = resolve({
      scripts: { test: "t" },
      lintlane: { checks: { nope: true, test: "missing", build: 5, biome: "x" } },
    });
    assert.equal(problems.length, 4);
    assert.match(problems.join("\n"), /unknown check/);
    assert.match(problems.join("\n"), /no script "missing"/);
    assert.deepEqual(
      steps.find((s) => s.id === "test").cmd,
      ["npm", "run", "test"],
      "falls back to detection",
    );
  });

  it("uses the package manager's script runner", () => {
    const { steps } = resolve({ scripts: { build: "b" } }, "pnpm");
    assert.deepEqual(steps.find((s) => s.id === "build").cmd, ["pnpm", "run", "build"]);
  });
});

describe("generated CI follows the same checks", () => {
  it("renders a step for every check that runs in CI, and none for disabled ones", () => {
    const { steps } = resolve({
      scripts: { typecheck: "tsc", build: "b", test: "t" },
      lintlane: { checks: { build: false } },
    });
    const yaml = renderWorkflow({
      pmName: "npm",
      kitName: "lintlane",
      withCommitCheck: false,
      checks: steps,
    });
    assert.match(yaml, /run: npx biome ci/);
    assert.match(yaml, /run: npm run typecheck/);
    assert.match(yaml, /run: npm run test/);
    assert.doesNotMatch(yaml, /npm run build/);
    assert.doesNotMatch(yaml, /npm ci\n.*npm ci/s);
  });

  it("init writes a workflow from the project's checks", () => {
    const dir = tempDir();
    write(dir, "package.json", JSON.stringify({ name: "a", scripts: { test: "t", build: "b" } }));
    gitOut(dir, "init", "-q", "-b", "main");
    const result = runCli(["init", "--skip-install"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const yaml = readFileSync(join(dir, ".github/workflows/biome.yml"), "utf8");
    assert.match(yaml, /run: npm run test/);
    assert.match(yaml, /run: npm run build/);
  });
});

describe("lintlane run", () => {
  function project(scripts, lintlane) {
    const dir = tempDir();
    const pkg = { name: "a", scripts, ...(lintlane ? { lintlane } : {}) };
    write(dir, "package.json", `${JSON.stringify(pkg, null, "\t")}\n`);
    write(dir, "biome.json", '{\n\t"files": { "includes": ["a.js"] }\n}\n');
    write(dir, "a.js", "export const a = 1;\n");
    return dir;
  }

  it("--list shows the checks", () => {
    const dir = project({ build: "echo hi" });
    const result = runCli(["run", "--list"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /biome\s+on/);
    assert.match(result.stdout, /build\s+on/);
    assert.match(result.stdout, /install\s+off/);
  });

  it("runs the checks in order and stops at the first failure", () => {
    const dir = project({ typecheck: 'node -e "process.exit(2)"', build: "echo built" });
    const result = runCli(["run"], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✔ Biome CI/);
    assert.match(result.stdout, /✘ Typecheck/);
    assert.match(result.stdout, /- skipped Build/);
  });

  it("--keep-going runs everything; exit 0 when all pass", () => {
    const dir = project({ typecheck: 'node -e "process.exit(2)"', build: "echo built" });
    const result = runCli(["run", "--keep-going"], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /✔ Build/);

    const green = runCli(["run", "build"], { cwd: dir });
    assert.equal(green.status, 0, green.stdout + green.stderr);
  });

  it("rejects unknown check names", () => {
    const dir = project({});
    const result = runCli(["run", "nope"], { cwd: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown check: nope/);
  });
});
