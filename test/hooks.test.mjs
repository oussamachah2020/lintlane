// The git hooks, run by real git in temporary repositories: staged files go
// through lint-staged + Biome, messages through commitlint, pushes through commitlint.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BIOME_CONFIG,
  commit,
  committed,
  git,
  gitOut,
  KIT_BIOME,
  KIT_DIR,
  read,
  runCli,
  snapshot,
  staged,
  tempDir,
  write,
} from "./helpers.mjs";

const hookTemplate = (name) => `#!/bin/sh\n${readTemplate(name)}`;

import { readFileSync } from "node:fs";

const readTemplate = (name) => readFileSync(join(KIT_DIR, "templates", name), "utf8");

/** A repo wired like `lintlane init` + install would leave it. */
function createProject({ files = {}, pkg = {} } = {}) {
  const dir = tempDir();
  gitOut(dir, "init", "-q", "-b", "main");
  gitOut(dir, "config", "commit.gpgsign", "false");
  gitOut(dir, "config", "core.autocrlf", "false");
  write(
    dir,
    "package.json",
    JSON.stringify(
      {
        name: "app",
        "lint-staged": {
          "*": "biome check --write --no-errors-on-unmatched --files-ignore-unknown=true",
        },
        ...pkg,
      },
      null,
      2,
    ),
  );
  write(dir, "biome.json", JSON.stringify(BIOME_CONFIG, null, 2));
  write(dir, "commitlint.config.mjs", 'export { default } from "lintlane/commitlint";\n');
  for (const [path, content] of Object.entries(files)) write(dir, path, content);
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  symlinkSync(KIT_DIR, join(dir, "node_modules", "lintlane"), "dir");
  symlinkSync(KIT_BIOME, join(dir, "node_modules", ".bin", "biome"));
  write(dir, ".gitignore", "node_modules\n");
  for (const name of ["pre-commit", "commit-msg", "pre-push"]) {
    const hookPath = join(dir, ".husky", name);
    mkdirSync(join(dir, ".husky"), { recursive: true });
    writeFileSync(hookPath, hookTemplate(name));
    chmodSync(hookPath, 0o755);
  }
  gitOut(dir, "add", "-A");
  gitOut(dir, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "chore: initial commit");
  gitOut(dir, "config", "core.hooksPath", ".husky");
  return dir;
}

describe("pre-commit (lint-staged + Biome)", () => {
  it("formats staged files and commits the formatted content", () => {
    const dir = createProject({ files: { "a.js": "export const a = 1;\n" } });
    write(dir, "a.js", "export const a   =   2\n");
    gitOut(dir, "add", "a.js");
    const result = commit(dir, "feat: change a");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "a.js"), "export const a = 2;\n");
    assert.equal(read(dir, "a.js"), "export const a = 2;\n");
  });

  it("commits only the staged part of a partially staged file and keeps the unstaged edit", () => {
    const dir = createProject({
      files: { "a.js": "export const a = 1;\n\nexport const b = 1;\n" },
    });
    write(dir, "a.js", "export const a   =   2\n\nexport const b = 1;\n");
    gitOut(dir, "add", "a.js");
    write(dir, "a.js", "export const a   =   2\n\nexport const b = 3;\n");
    const result = commit(dir, "feat: change a");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "a.js"), "export const a = 2;\n\nexport const b = 1;\n");
    assert.match(read(dir, "a.js"), /export const b = 3;/, "unstaged edit survives");
    assert.match(gitOut(dir, "status", "--porcelain"), /^ ?M a\.js/m, "still shows as modified");
  });

  it("never stages other tracked or untracked files", () => {
    const dir = createProject({
      files: { "a.js": "export const a = 1;\n", "b.js": "export const b = 1;\n" },
    });
    write(dir, "a.js", "export const a   =   2\n");
    write(dir, "b.js", "export const b   =   9\n"); // unstaged
    write(dir, "new.js", "export const n   =   1\n"); // untracked
    gitOut(dir, "add", "a.js");
    const result = commit(dir, "feat: change a");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "b.js"), "export const b = 1;\n");
    assert.equal(read(dir, "b.js"), "export const b   =   9\n");
    assert.equal(read(dir, "new.js"), "export const n   =   1\n");
  });

  it("blocks on a lint error and leaves the index and working tree unchanged", () => {
    const dir = createProject({
      files: { "a.js": "export const a = 1;\n", "b.js": "export const b = 1;\n" },
    });
    write(dir, "a.js", "export const a   =   2\n");
    write(dir, "b.js", "debugger;\nexport const b = 1;\n");
    gitOut(dir, "add", "a.js", "b.js");
    const before = snapshot(dir);
    const result = commit(dir, "feat: break things");
    assert.notEqual(result.status, 0);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(staged(dir, "a.js"), "export const a   =   2\n", "no half-applied fix");
  });

  it("handles file names with spaces", () => {
    const dir = createProject();
    write(dir, "my file.js", "export const a   =   1\n");
    gitOut(dir, "add", "my file.js");
    const result = commit(dir, "feat: add file");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(committed(dir, "my file.js"), "export const a = 1;\n");
  });
});

describe("commit-msg (commitlint)", () => {
  it("rejects bad messages and accepts Conventional Commits", () => {
    const dir = createProject();
    write(dir, "a.js", "export const a = 1;\n");
    gitOut(dir, "add", "a.js");
    const bad = commit(dir, "added stuff");
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout + bad.stderr, /subject may not be empty|type may not be empty/);
    assert.equal(commit(dir, "feat: add a").status, 0);
  });

  it("honors lintlane.commit.types and messageLengthLimit from package.json", () => {
    const dir = createProject({
      pkg: { lintlane: { commit: { types: ["feat", "fix"], messageLengthLimit: 30 } } },
    });
    write(dir, "a.js", "export const a = 1;\n");
    gitOut(dir, "add", "a.js");
    const wrongType = commit(dir, "chore: tidy");
    assert.notEqual(wrongType.status, 0);
    assert.match(wrongType.stdout + wrongType.stderr, /type must be one of/);
    const tooLong = commit(dir, "feat: a very long subject that goes on and on");
    assert.notEqual(tooLong.status, 0);
    assert.equal(commit(dir, "feat: short one").status, 0);
  });

  it("honors lintlane.commit.allowedPrefixes", () => {
    const dir = createProject({ pkg: { lintlane: { commit: { allowedPrefixes: ["WIP"] } } } });
    write(dir, "a.js", "export const a = 1;\n");
    gitOut(dir, "add", "a.js");
    assert.equal(commit(dir, "WIP saving my place").status, 0);
  });
});

describe("prepare-commit-msg", () => {
  it("stays out of the way for -m, CI and when there is no terminal", () => {
    const dir = createProject();
    const file = join(dir, "MSG");
    writeFileSync(file, "feat: x\n");
    for (const args of [[file, "message"], [file]]) {
      const result = runCli(["hook", "prepare-commit-msg", ...args], {
        cwd: dir,
        env: { CI: "1" },
      });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.equal(read(dir, "MSG"), "feat: x\n");
  });
});

describe("pre-push (commitlint over the pushed range)", () => {
  function withRemote() {
    const dir = createProject({ files: { "a.js": "export const a = 1;\n" } });
    const remote = tempDir("lintlane-remote-");
    gitOut(remote, "init", "-q", "--bare", "-b", "main");
    gitOut(dir, "remote", "add", "origin", remote);
    gitOut(dir, "-c", "core.hooksPath=/dev/null", "push", "-q", "-u", "origin", "main");
    return dir;
  }

  it("blocks a push containing a commit that skipped commit-msg, and allows good ones", () => {
    const dir = withRemote();
    write(dir, "a.js", "export const a = 2;\n");
    gitOut(dir, "add", "a.js");
    gitOut(dir, "commit", "-q", "--no-verify", "-m", "not conventional");
    const blocked = git(dir, "push", "origin", "main");
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /Push blocked/);

    gitOut(dir, "commit", "-q", "--no-verify", "--amend", "-m", "fix: conventional now");
    const allowed = git(dir, "push", "origin", "main");
    assert.equal(allowed.status, 0, allowed.stderr);
  });

  it("checks every commit of a new branch", () => {
    const dir = withRemote();
    gitOut(dir, "checkout", "-q", "-b", "topic");
    write(dir, "a.js", "export const a = 3;\n");
    gitOut(dir, "add", "a.js");
    gitOut(dir, "commit", "-q", "--no-verify", "-m", "oops");
    const blocked = git(dir, "push", "-u", "origin", "topic");
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /Push blocked/);
  });
});
