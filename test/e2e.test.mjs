// REAL end-to-end tests: real package managers, the real npm registry, the
// packed tarball, real husky. Slow and network-dependent, so opt in:
//
//     LINTLANE_E2E=1 npm test            (or: npm run test:e2e)
//
// Each package manager that isn't installed on the machine is skipped (and
// reported as skipped, not passed); the mocked tests in cli.test.mjs cover
// command generation for all four.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { cleanEnv, commit, committed, gitOut, KIT_DIR, read, tempDir, write } from "./helpers.mjs";

const ENABLED = process.env.LINTLANE_E2E === "1";
const SKIP_ALL = ENABLED
  ? false
  : "set LINTLANE_E2E=1 to run (needs network and real package managers)";
const TIMEOUT = 240_000;

const which = (name) => {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

/**
 * PATH containing only the named tools (plus node, git and the system dirs),
 * so a test can prove a flow works while Bun (or another manager) is absent.
 */
function toolEnv(tools, extra = {}) {
  const bin = tempDir("lintlane-e2e-bin-");
  for (const name of new Set(["node", "git", ...tools])) {
    const found = name === "node" ? process.execPath : which(name);
    if (found) symlinkSync(found, join(bin, name));
  }
  return cleanEnv({ PATH: `${bin}:/usr/bin:/bin`, ...extra });
}

const run = (command, args, options) =>
  spawnSync(command, args, { encoding: "utf8", timeout: TIMEOUT, ...options });

const STAGED_TEXT = "export const a   =   10\n\nexport const b = 2;\n\nexport const c = 3;\n";
const WORKING_TEXT = "export const a   =   10\n\nexport const b = 2;\n\nexport const c   =   30\n";
const FORMATTED = "export const a = 1;\n\nexport const b = 2;\n\nexport const c = 3;\n";
const STAGED_FORMATTED = "export const a = 10;\n\nexport const b = 2;\n\nexport const c = 3;\n";
const WORKING_MERGED = "export const a = 10;\n\nexport const b = 2;\n\nexport const c   =   30\n";

function newProject() {
  const dir = tempDir("lintlane-e2e-");
  write(
    dir,
    "package.json",
    `${JSON.stringify({ name: "e2e-app", version: "1.0.0", private: true }, null, 2)}\n`,
  );
  write(dir, ".gitignore", "node_modules\n");
  gitOut(dir, "init", "-q", "-b", "main");
  gitOut(dir, "config", "commit.gpgsign", "false");
  return dir;
}

/** After `init`: the project works, the hooks are live, and partial staging is safe. */
function assertProjectWorks(dir) {
  const pkg = JSON.parse(read(dir, "package.json"));
  for (const name of ["@biomejs/biome", "husky", "lintlane"]) {
    assert.ok(pkg.devDependencies?.[name], `${name} is recorded in devDependencies`);
  }
  assert.equal(pkg.scripts.prepare, "husky");
  assert.ok(
    existsSync(join(dir, "node_modules", "lintlane", "bin", "cli.mjs")),
    "lintlane is installed",
  );
  assert.equal(
    gitOut(dir, "config", "core.hooksPath").trim(),
    ".husky/_",
    "husky activated the hooks",
  );
  for (const hook of ["pre-commit", "commit-msg", "prepare-commit-msg", "pre-push"]) {
    assert.ok(existsSync(join(dir, ".husky", hook)), hook);
  }

  const doctor = spawnSync(
    "node",
    [join(dir, "node_modules", "lintlane", "bin", "cli.mjs"), "doctor", "--json"],
    {
      cwd: dir,
      encoding: "utf8",
      env: cleanEnv(),
    },
  );
  const report = JSON.parse(doctor.stdout);
  assert.deepEqual(
    report.findings.filter((f) => f.status === "fail"),
    [],
    "doctor finds nothing broken after init",
  );

  // Seed a formatted file, then stage part of an edit and keep editing.
  write(dir, "a.js", FORMATTED);
  gitOut(dir, "add", "-A");
  const seed = commit(dir, "chore: seed");
  assert.equal(seed.status, 0, seed.stderr);

  write(dir, "a.js", STAGED_TEXT);
  gitOut(dir, "add", "a.js");
  write(dir, "a.js", WORKING_TEXT);

  const headBefore = gitOut(dir, "rev-parse", "HEAD");
  const bad = commit(dir, "test");
  assert.notEqual(bad.status, 0, "a non-conventional message is rejected");
  assert.match(bad.stdout + bad.stderr, /(subject|type) may not be empty/);
  assert.equal(gitOut(dir, "rev-parse", "HEAD"), headBefore, "no commit was made");
  // The pre-commit hook ran first: it formatted the staged content and merged that into the
  // working file, but the developer's unstaged edit is still there, byte for byte.
  assert.equal(read(dir, "a.js"), WORKING_MERGED);

  const good = commit(dir, "feat: change a");
  assert.equal(good.status, 0, good.stderr);
  assert.equal(
    committed(dir, "a.js"),
    STAGED_FORMATTED,
    "only the staged change is committed, formatted",
  );
  assert.equal(read(dir, "a.js"), WORKING_MERGED, "the unstaged edit survives byte for byte");
}

describe("real end-to-end", { skip: SKIP_ALL }, () => {
  let tarball;
  let unpacked;

  before(() => {
    const out = tempDir("lintlane-e2e-pack-");
    const packed = run("npm", ["pack", "--pack-destination", out, "--json"], { cwd: KIT_DIR });
    assert.equal(packed.status, 0, packed.stderr);
    tarball = join(out, JSON.parse(packed.stdout)[0].filename);
    const extract = run("tar", ["-xzf", tarball, "-C", out]);
    assert.equal(extract.status, 0, extract.stderr);
    unpacked = join(out, "package");
    assert.ok(existsSync(join(unpacked, "bin", "cli.mjs")));
  });

  describe("launched like a user would, with Bun not installed", () => {
    it("`npx lintlane init` (real npm)", {
      timeout: TIMEOUT,
      skip: which("npm") ? false : "npm not installed",
    }, () => {
      const dir = newProject();
      const env = toolEnv(["npm", "npx"], { LINTLANE_INSTALL_SPEC: tarball });
      assert.ok(run("bun", ["--version"], { env }).error, "Bun must not be reachable");

      const result = run("npx", ["--yes", `--package=${tarball}`, "lintlane", "init", "--no-ci"], {
        cwd: dir,
        env,
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /Detected package manager: npm/);
      assertProjectWorks(dir);
    });

    it("`pnpm dlx lintlane init` (real pnpm)", {
      timeout: TIMEOUT,
      skip: which("pnpm") ? false : "pnpm not installed",
    }, () => {
      const dir = newProject();
      const env = toolEnv(["pnpm", "npm"], { LINTLANE_INSTALL_SPEC: tarball });
      const result = run("pnpm", ["dlx", tarball, "init", "--no-ci"], { cwd: dir, env });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /Detected package manager: pnpm/);
      assertProjectWorks(dir);
    });

    it("`yarn dlx lintlane init` (real yarn)", {
      timeout: TIMEOUT,
      skip: !which("yarn")
        ? "yarn is not installed on this machine (mocked tests only)"
        : run("yarn", ["--version"]).stdout.startsWith("1.")
          ? "yarn dlx needs Yarn 2+ (this is Yarn 1)"
          : false,
    }, () => {
      const dir = newProject();
      const env = toolEnv(["yarn"], { LINTLANE_INSTALL_SPEC: tarball });
      const result = run("yarn", ["dlx", tarball, "init", "--no-ci"], { cwd: dir, env });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assertProjectWorks(dir);
    });
  });

  describe("the CLI runs on Node while a project uses each package manager (real installs)", () => {
    for (const [pm, lockfileDetector] of [
      ["npm", "npm"],
      ["pnpm", "pnpm"],
      ["yarn", "yarn"],
      ["bun", "bun"],
    ]) {
      it(`${pm}: init installs with ${pm} and the project works`, {
        timeout: TIMEOUT,
        skip: which(pm) ? false : `${pm} is not installed on this machine (mocked tests only)`,
      }, () => {
        const dir = newProject();
        const env = toolEnv([pm, "npm"], {
          LINTLANE_INSTALL_SPEC: tarball,
          npm_config_user_agent: `${lockfileDetector}/1.0.0 node/${process.version}`,
        });
        const result = run("node", [join(unpacked, "bin", "cli.mjs"), "init", "--no-ci"], {
          cwd: dir,
          env,
        });
        assert.equal(result.status, 0, result.stderr + result.stdout);
        assert.match(result.stdout, new RegExp(`Detected package manager: ${pm}`));
        assertProjectWorks(dir);
      });
    }
  });

  describe("Bun users", () => {
    it("`bun` can run the CLI under the Bun runtime too", {
      timeout: TIMEOUT,
      skip: which("bun") ? false : "bun is not installed on this machine",
    }, () => {
      const dir = newProject();
      const env = toolEnv(["bun"]);
      const help = run("bun", [join(unpacked, "bin", "cli.mjs"), "--help"], { cwd: dir, env });
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /Usage:/);

      const init = run(
        "bun",
        [join(unpacked, "bin", "cli.mjs"), "init", "--skip-install", "--no-ci"],
        { cwd: dir, env },
      );
      assert.equal(init.status, 0, init.stderr + init.stdout);
      assert.ok(existsSync(join(dir, ".husky", "pre-commit")));
    });

    it("`bunx lintlane init` works with a local tarball (real bun)", {
      timeout: TIMEOUT,
      skip: which("bun") ? false : "bun is not installed on this machine",
    }, () => {
      const dir = newProject();
      const env = toolEnv(["bun", "bunx", "npm"], { LINTLANE_INSTALL_SPEC: tarball });
      // bunx can't take a tarball path directly, so install it first, then use the local bin like a user would.
      const add = run("bun", ["add", "--dev", "--exact", tarball], { cwd: dir, env });
      assert.equal(add.status, 0, add.stderr);
      const result = run("bunx", ["lintlane", "init", "--no-ci"], { cwd: dir, env });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assertProjectWorks(dir);
    });
  });

  // Keep these imports used even when every manager above is skipped.
  void [chmodSync, mkdirSync, readFileSync, writeFileSync];
});
