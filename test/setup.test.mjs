// init --dry-run, safe upgrades from older lintlane versions, and `lintlane doctor`.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classifyHook } from "../bin/project.mjs";
import { gitOut, KIT_BIOME, KIT_DIR, read, runCli, tempDir, write } from "./helpers.mjs";

const template = (name) => readFileSync(join(KIT_DIR, "templates", name), "utf8");

function project({ pkg = { name: "app", version: "1.0.0" }, files = {} } = {}) {
  const dir = tempDir();
  write(dir, "package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  gitOut(dir, "init", "-q", "-b", "main");
  return dir;
}

/** What `init` + an install leave behind: node_modules with lintlane, Biome and husky. */
function installed(dir) {
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  symlinkSync(KIT_DIR, join(dir, "node_modules", "lintlane"), "dir");
  symlinkSync(KIT_BIOME, join(dir, "node_modules", ".bin", "biome"));
  write(dir, "node_modules/.bin/husky", "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "node_modules/.bin/husky"), 0o755);
}

const tree = (dir, prefix = "") =>
  readdirSync(join(dir, prefix), { withFileTypes: true })
    .filter((entry) => entry.name !== ".git")
    .flatMap((entry) =>
      entry.isDirectory() ? tree(dir, join(prefix, entry.name)) : [join(prefix, entry.name)],
    )
    .sort();

describe("init --dry-run", () => {
  it("lists what it would do and changes nothing", () => {
    const dir = project({ pkg: { name: "app", dependencies: { react: "19" } } });
    const before = read(dir, "package.json");
    const files = tree(dir);
    const result = runCli(["init", "--dry-run"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /Dry run/);
    assert.match(result.stdout, /would run: npm install .*lintlane@/);
    assert.match(result.stdout, /would write biome\.json/);
    assert.match(result.stdout, /would write \.husky\/pre-commit/);
    assert.match(result.stdout, /would write commitlint\.config\.mjs/);
    assert.match(result.stdout, /would write \.github\/workflows\/biome\.yml/);
    assert.equal(read(dir, "package.json"), before);
    assert.deepEqual(tree(dir), files);
  });

  it("does not install anything, even without --skip-install", () => {
    const dir = project();
    const result = runCli(["init", "--dry-run"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.equal(existsSync(join(dir, "node_modules")), false);
  });
});

describe("init is idempotent and preserves what exists", () => {
  it("a second run reports everything up to date and changes nothing", () => {
    const dir = project();
    assert.equal(runCli(["init", "--skip-install"], { cwd: dir }).status, 0);
    const files = tree(dir);
    const pkg = read(dir, "package.json");
    const second = runCli(["init", "--skip-install"], { cwd: dir });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /\.husky\/pre-commit is up to date/);
    assert.equal(read(dir, "package.json"), pkg);
    assert.deepEqual(tree(dir), files);
  });

  it("keeps existing lint-staged, commitlint and Commitizen configuration", () => {
    const pkg = {
      name: "app",
      "lint-staged": { "*.js": "eslint" },
      config: { commitizen: { path: "cz-customizable" } },
    };
    const dir = project({ pkg, files: { ".commitlintrc.json": '{"extends":["x"]}\n' } });
    const result = runCli(["init", "--skip-install", "--no-ci"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    const after = JSON.parse(read(dir, "package.json"));
    assert.deepEqual(after["lint-staged"], { "*.js": "eslint" });
    assert.equal(after.config.commitizen.path, "cz-customizable");
    assert.equal(existsSync(join(dir, "commitlint.config.mjs")), false);
  });

  it("upgrades untouched hooks from lintlane 3.x, whose helper files no longer exist", () => {
    const dir = project({
      files: {
        ".husky/pre-commit":
          'if [ -f node_modules/lintlane/bin/pre-commit.mjs ]; then\n  node node_modules/lintlane/bin/pre-commit.mjs\nelse\n  echo "lintlane: node_modules/lintlane not found; skipping staged-file checks. Run your package manager\'s install." >&2\nfi\n',
        ".husky/commit-msg":
          '[ -f node_modules/lintlane/bin/commit-msg.mjs ] || exit 0\nnode node_modules/lintlane/bin/commit-msg.mjs "$1"\n',
      },
    });
    const result = runCli(["init", "--skip-install", "--no-ci"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(dir, ".husky/pre-commit"), template("pre-commit"));
    assert.equal(read(dir, ".husky/commit-msg"), template("commit-msg"));
  });

  it("warns about, and keeps, an edited hook that still calls removed files", () => {
    const custom = "npm run lint\nnode node_modules/lintlane/bin/pre-commit.mjs\n";
    const dir = project({ files: { ".husky/pre-commit": custom } });
    const result = runCli(["init", "--skip-install", "--no-ci"], { cwd: dir });
    assert.equal(read(dir, ".husky/pre-commit"), custom);
    assert.match(result.stdout, /no longer ships/);
    assert.match(result.stdout, /templates\/pre-commit/);
  });

  it("does not bump a Biome or husky version the project already has", () => {
    const dir = project({
      pkg: { name: "app", devDependencies: { "@biomejs/biome": "2.2.0", husky: "9.0.0" } },
    });
    const result = runCli(["init", "--dry-run"], { cwd: dir });
    assert.match(result.stdout, /would run: npm install --save-dev --save-exact lintlane@/);
    assert.doesNotMatch(result.stdout, /@biomejs\/biome[ @]/);
  });
});

describe("classifyHook", () => {
  const current = template("pre-commit");
  it("tells apart current, legacy, stale, unsafe and custom hooks", () => {
    assert.equal(classifyHook("pre-commit", current, current), "current");
    assert.equal(
      classifyHook(
        "pre-push",
        '[ -f node_modules/lintlane/bin/pre-push-check.mjs ] || exit 0\nnode node_modules/lintlane/bin/pre-push-check.mjs "$1" "$2"\n',
        template("pre-push"),
      ),
      "legacy",
    );
    assert.equal(classifyHook("pre-commit", "x\nnode lintlane/bin/staged.mjs\n", current), "stale");
    assert.equal(
      classifyHook("pre-commit", "biome x\ngit update-index --again\n", current),
      "unsafe",
    );
    assert.equal(classifyHook("pre-commit", "npm test\n", current), "custom");
  });
});

describe("lintlane doctor", () => {
  const doctor = (dir, ...args) => runCli(["doctor", ...args], { cwd: dir });
  const byId = (report, id) => report.findings.find((f) => f.id === id);

  it("passes on a healthy project and prints JSON with --json", () => {
    const dir = project({ pkg: { name: "app", devDependencies: { husky: "9.1.7" } } });
    assert.equal(runCli(["init", "--skip-install"], { cwd: dir }).status, 0);
    installed(dir);
    gitOut(dir, "config", "core.hooksPath", ".husky/_");
    const result = doctor(dir, "--json");
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true, result.stdout);
    assert.equal(result.status, 0);
    for (const id of [
      "node",
      "package-json",
      "git",
      "biome",
      "hook:pre-commit",
      "lint-staged-config",
      "commitlint-config",
      "ci",
    ]) {
      assert.equal(byId(report, id)?.status, "pass", id);
    }
  });

  it("human output lists fixes", () => {
    const dir = project();
    const result = doctor(dir);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /lintlane doctor/);
    assert.match(result.stdout, /✘ lintlane isn't installed/);
    assert.match(result.stdout, /! Biome isn't installed in this project/);
    assert.match(result.stdout, /→ Install it: npm install --save-dev --save-exact lintlane/);
  });

  it("fails, with the fix, for an old hook that would silently do nothing", () => {
    const dir = project({
      pkg: { name: "app", devDependencies: { husky: "9.1.7" }, scripts: { prepare: "husky" } },
      files: {
        ".husky/commit-msg":
          '[ -f node_modules/lintlane/bin/commit-msg.mjs ] || exit 0\nnode node_modules/lintlane/bin/commit-msg.mjs "$1"\n',
      },
    });
    installed(dir);
    const report = JSON.parse(doctor(dir, "--json").stdout);
    const finding = byId(report, "hook:commit-msg");
    assert.equal(finding.status, "fail");
    assert.match(finding.fix, /lintlane init/);
    assert.equal(report.ok, false);
  });

  it("flags hooks that exist but git isn't using", () => {
    const dir = project({ pkg: { name: "app", devDependencies: { husky: "9.1.7" } } });
    runCli(["init", "--skip-install"], { cwd: dir });
    installed(dir);
    const report = JSON.parse(doctor(dir, "--json").stdout);
    assert.equal(byId(report, "hooks-path").status, "fail");
  });

  it("warns when CI doesn't run a check the project has", () => {
    const dir = project({ pkg: { name: "app", scripts: { test: "node --test" } } });
    runCli(["init", "--skip-install"], { cwd: dir });
    installed(dir);
    write(dir, ".github/workflows/biome.yml", "name: x\njobs: {}\n");
    const report = JSON.parse(doctor(dir, "--json").stdout);
    assert.equal(byId(report, "ci").status, "warn");
    assert.match(byId(report, "ci").message, /npm run test/);
  });

  it("reports an invalid package.json and bad lintlane.checks config", () => {
    const dir = tempDir();
    write(dir, "package.json", "{ nope");
    const report = JSON.parse(doctor(dir, "--json").stdout);
    assert.equal(byId(report, "package-json").status, "fail");

    const dir2 = project({ pkg: { name: "app", lintlane: { checks: { bogus: true } } } });
    installed(dir2);
    const report2 = JSON.parse(doctor(dir2, "--json").stdout);
    assert.equal(byId(report2, "checks-config").status, "warn");
  });

  it("changes nothing", () => {
    const dir = project();
    runCli(["init", "--skip-install"], { cwd: dir });
    const files = tree(dir);
    const pkg = read(dir, "package.json");
    doctor(dir);
    assert.deepEqual(tree(dir), files);
    assert.equal(read(dir, "package.json"), pkg);
  });
});

it("preserves local tarball and version-range lintlane declarations", () => {
  for (const section of ["dependencies", "devDependencies"]) {
    for (const spec of ["file:../lintlane-4.1.2.tgz", "^4.1.1"]) {
      const dir = project({ pkg: { name: "app", [section]: { lintlane: spec } } });
      const result = runCli(["init", "--dry-run"], { cwd: dir });
      assert.equal(result.status, 0);
      assert.doesNotMatch(result.stdout, /would run:.*lintlane@/);
    }
  }
});
