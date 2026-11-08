// `lintlane check-commit` — validate commit messages with commitlint.
//
//   --message "<msg>"            check a string (or pipe it in on stdin)
//   --commit-msg-file <path>     check a message file
//   --rev-range <a..b>           check every commit in a git range
//   -d, --use-default-range      same as --rev-range <default branch>..HEAD
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveTool, runInherit, runProcess } from "./proc.mjs";

const HELP = `Usage: lintlane check-commit [options]

Checks that commit messages follow Conventional Commits (commitlint). Give one of:
  --message <msg>            a message (or pipe one in: echo "feat: x" | lintlane check-commit)
  --commit-msg-file <path>   a file containing the message
  --rev-range <a..b>         every commit in a range, e.g. origin/main..HEAD
  -d, --use-default-range    shorthand for <default branch>..HEAD

Rules come from commitlint.config.mjs (see \`lintlane init\`) and the optional
"lintlane.commit" block in package.json.
`;

const err = (text) => process.stderr.write(`${text}\n`);

async function defaultBranch(cwd) {
  const head = await runProcess("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    cwd,
  });
  if (head.code === 0) return head.stdout.toString().trim();
  for (const name of ["origin/main", "origin/master", "main", "master"]) {
    const probe = await runProcess("git", ["rev-parse", "--verify", "-q", name], { cwd });
    if (probe.code === 0) return name;
  }
  return null;
}

export async function main(argv, cwd = process.cwd()) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        message: { type: "string" },
        "commit-msg-file": { type: "string" },
        "rev-range": { type: "string" },
        "use-default-range": { type: "boolean", short: "d" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch (error) {
    err(`✘ ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const commitlint = resolveTool("@commitlint/cli", "commitlint");
  if (!commitlint) {
    err("✘ commitlint isn't installed. Reinstall lintlane with your package manager.");
    return 1;
  }
  const base = [...commitlint.slice(1), "--cwd", cwd];
  const run = (args, input) =>
    input === undefined
      ? runInherit(commitlint[0], [...base, ...args], { cwd })
      : runProcess(commitlint[0], [...base, ...args], { cwd, input }).then((result) => {
          process.stdout.write(result.stdout);
          process.stderr.write(result.stderr);
          return result.code;
        });

  let range = values["rev-range"];
  if (values["use-default-range"]) {
    const branch = await defaultBranch(cwd);
    if (!branch) {
      err("✘ Couldn't find the default branch. Use --rev-range <a..b>.");
      return 1;
    }
    range = `${branch}..HEAD`;
  }
  if (range) {
    const [from, to = "HEAD"] = range.split("..");
    if (!from) {
      err('✘ --rev-range must look like "origin/main..HEAD".');
      return 2;
    }
    return run(["--from", from, "--to", to]);
  }
  if (values["commit-msg-file"]) return run(["--edit", values["commit-msg-file"]]);
  if (values.message !== undefined) return run([], values.message);
  if (!process.stdin.isTTY) {
    try {
      return run([], readFileSync(0, "utf8"));
    } catch {}
  }
  err(`✘ Nothing to check.\n\n${HELP}`);
  return 2;
}
