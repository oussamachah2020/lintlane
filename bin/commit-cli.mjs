// `lintlane commit` — guided Conventional Commit, run by Commitizen.
//
//   lintlane commit [commitizen options] [-- <git commit args>]
//
// Commitizen's own flags work as-is: --dry-run, --retry, -a, -S, ... and
// everything after -- goes to `git commit` (e.g. `-- -n` to skip hooks).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCommitizen, runInherit } from "./proc.mjs";

export const COMMIT_HELP = `Usage: lintlane commit [options] [-- <git commit args>]

Asks a few questions and creates a Conventional Commit (Commitizen). Alias: lintlane c

Options (passed to Commitizen):
  --dry-run         Show what would happen without committing
  --retry           Reuse the last commit message after a failed commit
  -a, --all         Stage all tracked changes first
  -S, --signoff     Sign off the commit

Anything after -- is passed to git commit:
  lintlane commit -- -S       sign the commit
  lintlane commit -- -n       skip git hooks

Needs "config.commitizen.path" in package.json; \`lintlane init\` adds it.
`;

const err = (text) => process.stderr.write(`${text}\n`);

function hasAdapter(cwd) {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    return (
      Boolean(pkg?.config?.commitizen?.path) ||
      existsSync(join(cwd, ".czrc")) ||
      existsSync(join(cwd, ".cz.json"))
    );
  } catch {
    return false;
  }
}

export async function runCommit({ argv, gitArgs = [], cwd = process.cwd() }) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(COMMIT_HELP);
    return 0;
  }
  const cz = resolveCommitizen();
  if (!cz) {
    err("✘ Commitizen isn't installed. Reinstall lintlane with your package manager.");
    return 1;
  }
  if (!hasAdapter(cwd)) {
    err(
      '✘ Commitizen has no adapter configured. Run `lintlane init`, or add to package.json:\n  "config": { "commitizen": { "path": "lintlane/presets/commitizen.cjs" } }',
    );
    return 1;
  }
  return runInherit(
    cz[0],
    [...cz.slice(1), ...argv, ...(gitArgs.length ? ["--", ...gitArgs] : [])],
    {
      cwd,
    },
  );
}
