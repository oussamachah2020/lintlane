// Integration tests for the CLI: it must run on plain Node.js (no Bun), pick the
// right package manager, initialize new and existing projects without clobbering
// anything, and generate working hooks and workflows.
//
// "mocked" tests use fake package-manager executables (see helpers.mjs) to check
// which command lintlane builds and runs. Real package managers are exercised in
// e2e.test.mjs (set LINTLANE_E2E=1).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  CLI,
  cleanEnv,
  commit,
  committed,
  fakePackageManagers,
  git,
  gitOut,
  KIT_BIOME,
  KIT_DIR,
  noBunEnv,
  read,
  runCli,
  tempDir,
  write,
} from "./helpers.mjs";

const KIT_PKG = JSON.parse(readFileSync(join(KIT_DIR, "package.json"), "utf8"));
const KIT_SPEC = `${KIT_PKG.name}@${KIT_PKG.version}`;
const HOOKS = ["pre-commit", "commit-msg", "prepare-commit-msg", "pre-push"];
const template = (name) => readFileSync(join(KIT_DIR, "templates", name), "utf8");

/** A project directory with a package.json (and a git repo, unless told otherwise). */
function project({ pkg = { name: "app", version: "1.0.0" }, files = {}, repo = true } = {}) {
  const dir = tempDir();
  write(dir, "package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  if (repo) gitOut(dir, "init", "-q", "-b", "main");
  return dir;
}

const json = (dir, path) => JSON.parse(read(dir, path));
const isExecutable = (dir, path) => (statSync(join(dir, path)).mode & 0o111) !== 0;

describe("runs on Node.js without Bun", () => {
  const nobun = noBunEnv();

  it("the test environment really has no Bun on PATH", {
    skip: nobun ? false : "Bun is on the system PATH",
  }, () => {
    const probe = spawnSync("bun", ["--version"], { env: nobun.env });
    assert.ok(probe.error, "`bun` must not be resolvable");
  });

  it("starts with a Node shebang and declares a Node engine, not a Bun one", () => {
    assert.equal(readFileSync(CLI, "utf8").split("\n")[0], "#!/usr/bin/env node");
    assert.match(KIT_PKG.engines.node, /^>=\d+/);
    assert.equal(KIT_PKG.engines.bun, undefined);
  });

  it("pins orchestrated tools and MCP dependencies exactly", () => {
    assert.deepEqual(Object.keys(KIT_PKG.dependencies).sort(), [
      "@commitlint/cli",
      "@commitlint/config-conventional",
      "@modelcontextprotocol/sdk",
      "commitizen",
      "cz-conventional-changelog",
      "lint-staged",
      "zod",
    ]);
    for (const [name, range] of Object.entries(KIT_PKG.dependencies)) {
      assert.match(range, /^\d+\.\d+\.\d+$/, `${name} is pinned`);
    }
  });

  it("no source file uses a Bun API or module", () => {
    for (const name of readdirSync(join(KIT_DIR, "bin"))) {
      const code = readFileSync(join(KIT_DIR, "bin", name), "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      assert.doesNotMatch(code, /\bBun\./, `${name} uses a Bun global`);
      assert.doesNotMatch(code, /from ["'](bun|bun:[a-z]+)["']/, `${name} imports from bun`);
      assert.doesNotMatch(code, /import\.meta\.dir\b/, `${name} uses import.meta.dir (Bun-only)`);
      assert.doesNotMatch(code, /#!\/usr\/bin\/env bun/, `${name} has a Bun shebang`);
    }
  });

  it("--help works", { skip: nobun ? false : "Bun is on the system PATH" }, () => {
    const result = runCli(["--help"], { env: nobun.env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: npx lintlane <command>/);
  });

  it("init works in a new npm project", {
    skip: nobun ? false : "Bun is on the system PATH",
  }, () => {
    const dir = project();
    const result = runCli(["init", "--skip-install"], { cwd: dir, env: nobun.env });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /Detected package manager: npm/);
    assert.equal(existsSync(join(dir, "biome.json")), true);
  });

  it("check, check-commit and commit run", {
    skip: nobun ? false : "Bun is on the system PATH",
  }, () => {
    const dir = project({
      files: {
        "biome.json": '{ "formatter": { "indentStyle": "space", "indentWidth": 2 } }\n',
        "a.js": "export const a = 1;\n",
        "commitlint.config.mjs": 'export { default } from "lintlane/commitlint";\n',
      },
    });
    gitOut(dir, "config", "commit.gpgsign", "false");
    const check = runCli(["check"], { cwd: dir, env: nobun.env });
    assert.equal(check.status, 0, check.stderr + check.stdout);

    mkdirp(join(dir, "node_modules"));
    symlinkSync(KIT_DIR, join(dir, "node_modules", "lintlane"), "dir");
    const ok = runCli(["check-commit", "--message", "feat: add thing"], {
      cwd: dir,
      env: nobun.env,
    });
    assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    const bad = runCli(["check-commit", "--message", "test"], { cwd: dir, env: nobun.env });
    assert.equal(bad.status, 1);

    const help = runCli(["commit", "--help"], { cwd: dir, env: nobun.env });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Commitizen/);
    const unconfigured = runCli(["commit", "--dry-run"], { cwd: dir, env: nobun.env });
    assert.equal(unconfigured.status, 1);
    assert.match(unconfigured.stderr, /no adapter configured/);
  });
});

describe("the published package contains everything the CLI needs", () => {
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: KIT_DIR,
    encoding: "utf8",
  });
  const files =
    packed.status === 0 ? JSON.parse(packed.stdout)[0].files.map((file) => file.path) : [];

  it("npm pack works and lists files", () => {
    assert.equal(packed.status, 0, packed.stderr);
    assert.ok(files.length > 10);
  });

  it("ships the bin entry, every module it imports, the templates, presets and dashboard page", () => {
    assert.ok(files.includes(KIT_PKG.bin.lintlane), "bin entry");
    for (const name of [...HOOKS, "pre-commit"])
      assert.ok(files.includes(`templates/${name}`), name);
    for (const preset of ["base", "strict", "next"])
      assert.ok(files.includes(`presets/${preset}.json`), preset);
    assert.ok(files.includes("ui/index.html"));
    assert.ok(files.includes("README.md"));

    const missing = [];
    for (const file of files.filter((f) => f.startsWith("bin/") && f.endsWith(".mjs"))) {
      const source = readFileSync(join(KIT_DIR, file), "utf8");
      for (const match of source.matchAll(/(?:from|import\()\s*["']\.\/([\w.-]+\.mjs)["']/g)) {
        if (!files.includes(`bin/${match[1]}`)) missing.push(`${file} -> ${match[1]}`);
      }
    }
    assert.deepEqual(missing, [], "every relative import must be in the package");
  });

  it("ships every file named by exports", () => {
    for (const target of Object.values(KIT_PKG.exports)) {
      assert.ok(files.includes(target.replace(/^\.\//, "")), target);
    }
  });

  it("does not ship tests, fixtures, tarballs or node_modules", () => {
    for (const file of files) {
      assert.doesNotMatch(file, /^(test|node_modules)\//, file);
      assert.doesNotMatch(file, /\.tgz$/, file);
    }
  });
});

describe("package manager used by init (MOCKED package managers)", () => {
  const cases = [
    ["npm", "package-lock.json", ["install", "--save-dev", "--save-exact"]],
    ["pnpm", "pnpm-lock.yaml", ["add", "--save-dev", "--save-exact"]],
    ["yarn", "yarn.lock", ["add", "--dev", "--exact"]],
    ["bun", "bun.lock", ["add", "--dev", "--exact"]],
  ];

  for (const [pm, lockfile, flags] of cases) {
    it(`runs \`${pm}\` for a project with ${lockfile} and keeps the installed dependencies`, () => {
      const fake = fakePackageManagers();
      const dir = project({ files: { [lockfile]: "" } });

      const result = runCli(["init"], { cwd: dir, env: fake.env });
      assert.equal(result.status, 0, result.stderr + result.stdout);

      const calls = fake.calls();
      assert.equal(
        calls.length,
        1,
        `expected one package-manager call, got ${JSON.stringify(calls)}`,
      );
      assert.equal(calls[0].pm, pm);
      assert.deepEqual(calls[0].argv, [...flags, "@biomejs/biome", KIT_SPEC, "husky"]);
      assert.equal(
        calls[0].cwd.endsWith(dir.split("/").pop()),
        true,
        "runs in the project directory",
      );

      // Regression: 2.5.0 wrote a stale package.json over the install's devDependencies.
      const pkg = json(dir, "package.json");
      assert.deepEqual(Object.keys(pkg.devDependencies).sort(), [
        "@biomejs/biome",
        "husky",
        "lintlane",
      ]);
      assert.equal(pkg.scripts.check, "biome check .");
      assert.equal(pkg.scripts["check:fix"], "biome check --write .");
      assert.equal(pkg.scripts.prepare, "husky");
      assert.match(result.stdout, /Installed @biomejs\/biome/);
      assert.match(result.stdout, /Ran husky/);
    });
  }

  it("uses the tool that launched lintlane when there is no lockfile (pnpm dlx)", () => {
    const fake = fakePackageManagers();
    const dir = project();
    const result = runCli(["init", "--no-ci"], {
      cwd: dir,
      env: { ...fake.env, npm_config_user_agent: "pnpm/9.1.0 npm/? node/v22.1.0 linux x64" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      fake.calls().map((call) => call.pm),
      ["pnpm"],
    );
  });

  it("falls back to npm, not Bun, when nothing identifies the package manager", () => {
    const fake = fakePackageManagers();
    const dir = project();
    const result = runCli(["init", "--no-ci"], { cwd: dir, env: fake.env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      fake.calls().map((call) => call.pm),
      ["npm"],
    );
  });

  it("the packageManager field wins over a lockfile", () => {
    const fake = fakePackageManagers();
    const dir = project({
      pkg: { name: "app", packageManager: "yarn@4.1.0" },
      files: { "package-lock.json": "{}" },
    });
    const result = runCli(["init", "--no-ci"], { cwd: dir, env: fake.env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      fake.calls().map((call) => call.pm),
      ["yarn"],
    );
  });

  it("installs from LINTLANE_INSTALL_SPEC when set (for testing a local build)", () => {
    const fake = fakePackageManagers();
    const dir = project({ files: { "package-lock.json": "{}" } });
    const result = runCli(["init", "--no-ci"], {
      cwd: dir,
      env: { ...fake.env, LINTLANE_INSTALL_SPEC: "/tmp/lintlane-build.tgz" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fake.calls()[0].argv.includes("/tmp/lintlane-build.tgz"));
    assert.ok(!fake.calls()[0].argv.includes(KIT_SPEC));
  });

  it("does not install husky with --no-hooks", () => {
    const fake = fakePackageManagers();
    const dir = project({ files: { "package-lock.json": "{}" } });
    runCli(["init", "--no-hooks", "--no-ci"], { cwd: dir, env: fake.env });
    assert.ok(!fake.calls()[0].argv.includes("husky"));
  });

  it("fails with a clear message, and writes nothing, when the package manager isn't installed", () => {
    const fake = fakePackageManagers([]); // no package manager executables at all
    const dir = project({ files: { "pnpm-lock.yaml": "" } });
    const result = runCli(["init"], { cwd: dir, env: fake.env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /"pnpm" was not found/);
    assert.match(result.stderr, /--skip-install/);
    assert.equal(existsSync(join(dir, "biome.json")), false);
    assert.equal(existsSync(join(dir, ".husky")), false);
  });

  it("reports a failing install instead of continuing", () => {
    const fake = fakePackageManagers([]);
    write(
      fake.env.PATH.split(":")[0],
      "npm",
      `#!${process.execPath}\nconsole.error("E404 not found");process.exit(1)\n`,
    );
    spawnSync("chmod", ["755", join(fake.env.PATH.split(":")[0], "npm")]);
    const dir = project();
    const result = runCli(["init"], { cwd: dir, env: fake.env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Install failed/);
    assert.match(result.stderr, /E404 not found/);
    assert.equal(existsSync(join(dir, "biome.json")), false);
  });
});

describe("init in a new project (no install)", () => {
  it("writes the config, scripts, hooks and workflow", () => {
    const dir = project({ pkg: { name: "app", dependencies: { react: "19" } } });
    const result = runCli(["init", "--skip-install"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /Detected React — using preset "base"/);

    assert.deepEqual(json(dir, "biome.json"), {
      $schema: "./node_modules/@biomejs/biome/configuration_schema.json",
      extends: ["lintlane/biome"],
    });
    const pkg = json(dir, "package.json");
    assert.deepEqual(
      { check: pkg.scripts.check, fix: pkg.scripts["check:fix"], prepare: pkg.scripts.prepare },
      { check: "biome check .", fix: "biome check --write .", prepare: "husky" },
    );

    for (const hook of HOOKS) {
      assert.equal(
        read(dir, `.husky/${hook}`),
        template(hook),
        `.husky/${hook} matches the template`,
      );
      assert.equal(isExecutable(dir, `.husky/${hook}`), true, `.husky/${hook} is executable`);
    }
    const workflow = read(dir, ".github/workflows/biome.yml");
    assert.match(workflow, /run: npm ci/);
    assert.match(workflow, /cli\.mjs check-commit/);

    assert.deepEqual(pkg["lint-staged"], {
      "*": "biome check --write --no-errors-on-unmatched --files-ignore-unknown=true",
    });
    assert.equal(pkg.config.commitizen.path, "lintlane/presets/commitizen.cjs");
    assert.equal(
      read(dir, "commitlint.config.mjs"),
      'export { default } from "lintlane/commitlint";\n',
    );
  });

  it("the generated pre-commit hook is the safe one", () => {
    const dir = project();
    runCli(["init", "--skip-install"], { cwd: dir });
    const hook = read(dir, ".husky/pre-commit");
    assert.match(hook, /cli\.mjs hook pre-commit/);
    assert.doesNotMatch(hook, /update-index/);
    assert.doesNotMatch(hook, /--staged/);
  });

  it("uses the next preset and ignores for Next.js apps", () => {
    const dir = project({ pkg: { name: "app", dependencies: { next: "15", react: "19" } } });
    const result = runCli(["init", "--skip-install", "--no-hooks", "--no-ci"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    const config = json(dir, "biome.json");
    assert.deepEqual(config.extends, ["lintlane/biome/next"]);
    assert.deepEqual(config.files.includes, ["**", "!**/.next", "!**/out", "!**/next-env.d.ts"]);
  });

  it("honors --preset", () => {
    const dir = project();
    runCli(["init", "--skip-install", "--no-hooks", "--no-ci", "--preset", "strict"], { cwd: dir });
    assert.deepEqual(json(dir, "biome.json").extends, ["lintlane/biome/strict"]);
  });

  it("rejects an unknown preset and a missing package.json", () => {
    const dir = project();
    const bad = runCli(["init", "--skip-install", "--preset", "nope"], { cwd: dir });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Invalid preset "nope"/);

    const empty = tempDir();
    const none = runCli(["init", "--skip-install"], { cwd: empty });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /No package\.json/);
  });

  it("--no-hooks, --no-commit-lint and --no-ci leave the right things out", () => {
    const noHooks = project();
    runCli(["init", "--skip-install", "--no-hooks"], { cwd: noHooks });
    assert.equal(existsSync(join(noHooks, ".husky")), false);
    assert.equal(json(noHooks, "package.json").scripts.prepare, undefined);
    assert.doesNotMatch(read(noHooks, ".github/workflows/biome.yml"), /check-commit/);

    const noLint = project();
    runCli(["init", "--skip-install", "--no-commit-lint"], { cwd: noLint });
    assert.deepEqual(readdirSync(join(noLint, ".husky")), ["pre-commit"]);
    assert.doesNotMatch(read(noLint, ".github/workflows/biome.yml"), /check-commit/);

    const noCi = project();
    runCli(["init", "--skip-install", "--no-ci"], { cwd: noCi });
    assert.equal(existsSync(join(noCi, ".github")), false);
  });

  it("skips the hooks, with a warning, when the project isn't a git repository", () => {
    const dir = project({ repo: false });
    const result = runCli(["init", "--skip-install", "--no-ci"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No \.git directory found/);
    assert.equal(existsSync(join(dir, ".husky")), false);
  });

  it("writes a workflow matching each detected package manager", () => {
    for (const [lockfile, expected] of [
      ["pnpm-lock.yaml", /pnpm install --frozen-lockfile/],
      ["yarn.lock", /yarn install --frozen-lockfile/],
      ["bun.lock", /bun install --frozen-lockfile/],
      ["package-lock.json", /npm ci/],
    ]) {
      const dir = project({ files: { [lockfile]: "" } });
      runCli(["init", "--skip-install", "--no-hooks"], { cwd: dir });
      assert.match(read(dir, ".github/workflows/biome.yml"), expected, lockfile);
    }
  });
});

describe("init in an existing project preserves what's there", () => {
  const customFiles = {
    "biome.json": '{ "extends": ["./my-base.json"] }\n',
    ".husky/pre-commit": "npm test\n",
    ".husky/commit-msg": "echo my commit-msg\n",
    ".github/workflows/biome.yml": "name: Mine\n",
  };
  const pkg = {
    name: "app",
    scripts: {
      check: "my check",
      "check:fix": "my fix",
      prepare: "node setup.js",
      build: "vite build",
    },
    dependencies: { react: "19" },
  };

  it("never overwrites config, scripts, hooks or the workflow, and appends husky to prepare", () => {
    const dir = project({ pkg, files: customFiles });
    const result = runCli(["init", "--skip-install"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr + result.stdout);

    for (const [path, content] of Object.entries(customFiles))
      assert.equal(read(dir, path), content, path);
    const after = json(dir, "package.json");
    assert.equal(after.scripts.check, "my check");
    assert.equal(after.scripts["check:fix"], "my fix");
    assert.equal(after.scripts.build, "vite build");
    assert.equal(after.scripts.prepare, "node setup.js && husky");
    assert.deepEqual(after.dependencies, { react: "19" });
    assert.match(result.stdout, /biome\.json already exists/);
    assert.match(result.stdout, /\.husky\/pre-commit already exists/);
    // Hooks that were missing are still added.
    assert.equal(read(dir, ".husky/pre-push"), template("pre-push"));
  });

  it("is idempotent: a second run changes nothing", () => {
    const dir = project();
    runCli(["init", "--skip-install"], { cwd: dir });
    const snapshot = (d) =>
      Object.fromEntries(
        [
          "package.json",
          "biome.json",
          ".github/workflows/biome.yml",
          ...HOOKS.map((h) => `.husky/${h}`),
        ].map((p) => [p, read(d, p)]),
      );
    const first = snapshot(dir);
    const second = runCli(["init", "--skip-install"], { cwd: dir });
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(snapshot(dir), first);
  });

  it("leaves a prepare script that already runs husky alone", () => {
    const dir = project({ pkg: { name: "app", scripts: { prepare: "husky" } } });
    runCli(["init", "--skip-install", "--no-ci"], { cwd: dir });
    assert.equal(json(dir, "package.json").scripts.prepare, "husky");
  });

  it("replaces the old unsafe pre-commit hook that earlier versions wrote", () => {
    const legacy =
      "./node_modules/.bin/biome check --write --staged --no-errors-on-unmatched --files-ignore-unknown=true\ngit update-index --again\n";
    const dir = project({ files: { ".husky/pre-commit": legacy } });
    const result = runCli(["init", "--skip-install", "--no-ci"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(read(dir, ".husky/pre-commit"), template("pre-commit"));
    assert.equal(isExecutable(dir, ".husky/pre-commit"), true);
    assert.match(result.stdout, /Upgrade \.husky\/pre-commit/);
  });

  it("warns about, but does not rewrite, a customized hook that still re-stages unsafely", () => {
    const custom = `npm run lint\n./node_modules/.bin/biome check --write --staged\ngit update-index --again\n`;
    const dir = project({ files: { ".husky/pre-commit": custom } });
    const result = runCli(["init", "--skip-install", "--no-ci"], { cwd: dir });
    assert.equal(read(dir, ".husky/pre-commit"), custom, "customized hooks are never rewritten");
    assert.match(result.stdout, /update-index --again/);
    assert.match(result.stdout, /can stage changes you didn't stage/);
  });
});

describe("generated hooks work end to end", () => {
  it("a project set up by init rejects bad messages and formats staged files", () => {
    const dir = project({ files: { ".gitignore": "node_modules\n" } });
    const result = runCli(["init", "--skip-install", "--no-ci"], { cwd: dir });
    assert.equal(result.status, 0, result.stderr);

    // Stand in for `npm install`: lintlane resolvable from node_modules; hooks live in .husky.
    mkdirp(join(dir, "node_modules"));
    symlinkSync(KIT_DIR, join(dir, "node_modules", "lintlane"), "dir");
    // ...and Biome, which lint-staged finds in node_modules/.bin.
    mkdirp(join(dir, "node_modules", ".bin"));
    symlinkSync(KIT_BIOME, join(dir, "node_modules", ".bin", "biome"));
    gitOut(dir, "config", "core.hooksPath", ".husky");
    gitOut(dir, "config", "commit.gpgsign", "false");

    write(dir, "a.js", "export const a   =   1\n");
    gitOut(dir, "add", "-A");

    const rejected = commit(dir, "test");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /(subject|type) may not be empty/);

    const accepted = commit(dir, "feat: add a");
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(committed(dir, "a.js"), "export const a = 1;\n");
  });
});

function mkdirp(path) {
  spawnSync("mkdir", ["-p", path]);
}

describe("check / check:fix / ci run Biome without a project-local install", () => {
  it("falls back to the Biome that ships alongside lintlane", () => {
    const dir = project({ files: { "biome.json": "{}\n", "a.js": "export const a   =   1\n" } });
    const check = runCli(["check"], { cwd: dir });
    assert.notEqual(check.status, 0, "unformatted file fails the check");
    const fix = runCli(["check:fix"], { cwd: dir });
    assert.equal(fix.status, 0, fix.stderr + fix.stdout);
    assert.equal(read(dir, "a.js"), "export const a = 1;\n");
    assert.equal(runCli(["ci"], { cwd: dir }).status, 0);
  });

  it("reports an unknown command", () => {
    const result = runCli(["frobnicate"], { cwd: project() });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown command "frobnicate"/);
  });
});

// Keep unused-import linting honest for helpers only some tests use.
void [cleanEnv, git];
