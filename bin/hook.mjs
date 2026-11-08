// Git hook entry points, run as `lintlane hook <name> [git args]` from the
// .husky/ scripts. Each one hands the real work to a proven tool:
//
//   pre-commit          lint-staged   (safe with partially staged files; runs Biome)
//   commit-msg          commitlint    (validates the message)
//   prepare-commit-msg  commitizen    (guided prompt on a plain `git commit`)
//   pre-push            commitlint    (checks every commit about to be pushed)
import { spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { resolveTool, runInherit, runProcess } from "./proc.mjs";

export const HOOKS = ["pre-commit", "commit-msg", "prepare-commit-msg", "pre-push"];

const ZERO = /^0+$/;
const err = (text) => process.stderr.write(`${text}\n`);

function tool(pkg, bin) {
  const argv = resolveTool(pkg, bin);
  if (!argv) {
    err(`lintlane: couldn't find ${pkg}. Reinstall lintlane with your package manager.`);
  }
  return argv;
}

async function gitText(args, cwd) {
  const result = await runProcess("git", args, { cwd });
  return result.code === 0 ? result.stdout.toString().trim() : null;
}

async function preCommit(cwd) {
  const argv = tool("lint-staged");
  if (!argv) return 1;
  return runInherit(argv[0], argv.slice(1), { cwd });
}

async function commitMsg(cwd, [file]) {
  if (!file) {
    err("lintlane: commit-msg expects the path to the commit message file.");
    return 2;
  }
  const argv = tool("@commitlint/cli", "commitlint");
  if (!argv) return 1;
  return runInherit(argv[0], [...argv.slice(1), "--edit", file, "--cwd", cwd], { cwd });
}

// A plain `git commit` (no -m, no template, not a merge or amend) gets the guided
// prompt. Anything else, or no terminal to ask on, is left alone.
function prepareCommitMsg(cwd, [file, source]) {
  if (!file || source || process.env.CI || process.env.LINTLANE_NO_PROMPT) return 0;
  if (process.platform === "win32") return 0;
  const argv = tool("commitizen", "git-cz");
  if (!argv) return 0;
  let tty;
  try {
    tty = openSync("/dev/tty", "r"); // git runs hooks with stdin detached
  } catch {
    return 0; // GUI client, script: stay out of the way
  }
  try {
    const result = spawnSync(argv[0], [...argv.slice(1), "--hook"], {
      cwd,
      stdio: [tty, "inherit", "inherit"],
    });
    return result.status ?? 1;
  } finally {
    closeSync(tty);
  }
}

async function lintRange(argv, cwd, from, to) {
  const result = await runProcess(
    argv[0],
    [...argv.slice(1), "--from", from, "--to", to, "--cwd", cwd],
    {
      cwd,
    },
  );
  if (result.code !== 0) {
    process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
  }
  return result.code === 0;
}

async function lintMessage(argv, cwd, message) {
  const result = await runProcess(argv[0], [...argv.slice(1), "--cwd", cwd], {
    cwd,
    input: message,
  });
  if (result.code !== 0) {
    process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
  }
  return result.code === 0;
}

// Safety net for commits that skipped commit-msg (--no-verify, a GUI client, a
// clone without hooks). Never blocks when a range can't be inspected.
async function prePush(cwd, [remote = "origin"], stdin) {
  const argv = tool("@commitlint/cli", "commitlint");
  if (!argv) return 1;
  let bad = 0;
  for (const line of stdin.split("\n")) {
    const [localRef, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localRef || !localSha || ZERO.test(localSha) || localRef.startsWith("refs/tags/"))
      continue;
    if (!ZERO.test(remoteSha ?? "0")) {
      if (!(await lintRange(argv, cwd, remoteSha, localSha))) bad++;
      continue;
    }
    // New branch: every commit not already on a remote.
    const listed = await gitText(
      ["rev-list", "--reverse", localSha, "--not", `--remotes=${remote}`],
      cwd,
    );
    const commits = listed ? listed.split("\n") : [];
    if (commits.length === 0) continue;
    if ((await gitText(["rev-parse", "--verify", "-q", `${commits[0]}^`], cwd)) !== null) {
      if (!(await lintRange(argv, cwd, `${commits[0]}^`, localSha))) bad++;
    } else {
      for (const sha of commits) {
        const message = await gitText(["log", "-1", "--format=%B", sha], cwd);
        if (message !== null && !(await lintMessage(argv, cwd, message))) bad++;
      }
    }
  }
  if (bad > 0) {
    err(
      "\n✘ Push blocked: some commit messages don't follow Conventional Commits.\n" +
        "  Reword them with `git rebase -i` (or `git commit --amend` for the latest), then push again.\n",
    );
    return 1;
  }
  return 0;
}

export async function runHook(name, args, cwd = process.cwd()) {
  switch (name) {
    case "pre-commit":
      return preCommit(cwd);
    case "commit-msg":
      return commitMsg(cwd, args);
    case "prepare-commit-msg":
      return prepareCommitMsg(cwd, args);
    case "pre-push": {
      let stdin = "";
      try {
        stdin = readFileSync(0, "utf8");
      } catch {}
      return prePush(cwd, args, stdin);
    }
    default:
      err(`lintlane: unknown hook "${name}". Known hooks: ${HOOKS.join(", ")}.`);
      return 2;
  }
}
