# lintlane

A code-quality workflow for JavaScript, React and Next.js projects. lintlane
**orchestrates proven tools instead of reimplementing them**: one command wires
them together, one config drives the checks everywhere, and a local dashboard
shows what your CI will say before you push.

| Job                                  | Tool                                                      |
| ------------------------------------ | --------------------------------------------------------- |
| Formatting and linting               | [Biome](https://biomejs.dev)                              |
| Staged files (partial staging safe)  | [lint-staged](https://github.com/lint-staged/lint-staged) |
| Git hooks                            | [Husky](https://typicode.github.io/husky)                 |
| Guided Conventional Commits          | [Commitizen](https://commitizen.github.io/cz-cli/)        |
| Commit message validation            | [commitlint](https://commitlint.js.org)                   |
| Setup, checks, CI, doctor, dashboard | **lintlane**                                              |

## Contents

- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Commands](#commands)
- [`init`](#init--one-time-setup)
- [Checks: one config for CLI, dashboard and CI](#checks-one-config-for-cli-dashboard-and-ci)
- [Git hooks](#git-hooks)
- [Commits](#commits)
- [`doctor`](#doctor)
- [Dashboard](#dashboard-ui)
- [Presets](#presets)
- [Migrating from lintlane 3.x](#migrating-from-lintlane-3x)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Limitations](#limitations)
- [Developing lintlane](#developing-lintlane)

## Quick start

```sh
# In a git repository with a package.json. Preview first, if you like:
npx lintlane init --dry-run
npx lintlane init

npx lintlane doctor      # verify the setup
npx lintlane run         # Biome + typecheck + build + tests, like CI
npx lintlane ui          # the dashboard
```

To install lintlane directly as a development dependency:

```sh
npm install -D lintlane
npx lintlane init
```

## Requirements

- **Node.js 22 or newer.** Any package manager: npm, pnpm, Yarn or Bun
  (`npx`, `pnpm dlx`, `yarn dlx`, `bunx`). `init` detects which one you use.
- **Biome 2.2 up to (not including) 3**, a peer dependency that `init` installs.
- **Git**.
- macOS or Linux for the guided prompt on a plain `git commit` (it reads the
  terminal through `/dev/tty`). Windows is untested; see [Limitations](#limitations).

## Commands

| Command                     | What it does                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `init [--dry-run]`          | Install and configure everything. Safe to re-run; never overwrites your config.           |
| `doctor [--json]`           | Diagnose the setup. Read-only. Exit code 1 only if something is broken.                   |
| `run [checks…]`             | Run the project's checks in order (`--list`, `--keep-going`).                             |
| `check`, `check:fix`, `ci`  | Run `biome check`, `biome check --write`, `biome ci`.                                     |
| `commit` (`c`)              | Guided Conventional Commit, run by Commitizen. Git flags go after `--`.                   |
| `check-commit`              | Validate messages with commitlint: `--message`, `--commit-msg-file`, `--rev-range`, `-d`. |
| `ui [--port n] [--no-open]` | The local dashboard.                                                                      |

## `init` — one-time setup

```sh
npx lintlane init [--dry-run] [--preset base|strict|next] [--no-hooks] [--no-commit-lint] [--no-ci] [--skip-install]
```

It installs `@biomejs/biome`, `lintlane` and (with hooks) `husky` as exact dev
dependencies — only those that are missing, so a Biome or Husky version you
already pin is never bumped — then adds only what is missing:

- `biome.json` extending the detected preset (Next.js → `next`; React, TanStack
  Start, React Router, Remix → `base`; `strict` only when you ask).
- `check`, `check:fix` and `prepare` scripts.
- a `lint-staged` entry in `package.json` that runs Biome on staged files.
- `commitlint.config.mjs` and `config.commitizen` in `package.json`.
- `.husky/pre-commit`, `commit-msg`, `prepare-commit-msg`, `pre-push`.
- `.github/workflows/biome.yml`, generated from your [checks](#checks-one-config-for-cli-dashboard-and-ci).

**`--dry-run`** prints every action (including the install command) and changes
nothing. **Re-running** is safe: whatever exists is reported and left alone. An
untouched hook from an older lintlane is upgraded; an edited one is never
rewritten, only reported. Existing lint-staged, commitlint and Commitizen
configuration is kept as it is.

The package manager comes from the `packageManager` field, then a lockfile, then
the tool that launched lintlane, then npm.

## Checks: one config for CLI, dashboard and CI

`lintlane run`, the dashboard's CI tab and the generated workflow all read the
same list, detected from `package.json`:

| id          | Runs                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `install`   | Frozen-lockfile install (off by default locally)                                                                    |
| `biome`     | `biome ci .`                                                                                                        |
| `typecheck` | script `typecheck`, `type-check`, `check-types` or `tsc`; else `tsc --noEmit` locally when a `tsconfig.json` exists |
| `build`     | script `build`                                                                                                      |
| `test`      | script `test` (npm's placeholder is ignored)                                                                        |

Tune it in `package.json`:

```json
{
  "lintlane": {
    "checks": { "build": false, "test": "test:unit" }
  }
}
```

`false` turns a check off everywhere, a string names the script to run, `true`
keeps the detected one. Unknown ids or missing scripts are reported by `doctor`
and the dashboard instead of failing silently. Only script names come from
config, never command lines.

The workflow is written once by `init`; after changing checks, `lintlane doctor`
tells you which CI steps are missing.

## Git hooks

Hooks are Husky scripts that call `lintlane hook <name>`, which runs the real tool:

| Hook                 | Does                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-commit`         | **lint-staged** runs `biome check --write` on staged files. Partially staged files keep their unstaged edits; nothing you didn't stage is committed. A lint error blocks the commit and changes nothing. |
| `commit-msg`         | **commitlint** validates the message.                                                                                                                                                                    |
| `prepare-commit-msg` | A plain `git commit` opens the **Commitizen** prompt (skipped for `-m`, merges, amends, CI, no terminal, `LINTLANE_NO_PROMPT=1`).                                                                        |
| `pre-push`           | **commitlint** checks every commit being pushed, catching `--no-verify` and GUI clients.                                                                                                                 |

Customize staged-file processing in the `lint-staged` key of `package.json` (or
any lint-staged config file). Bypass once with `git commit --no-verify`.

## Commits

```sh
npx lintlane commit            # guided prompt
npx lintlane commit -- -S      # extra args go to git commit
npx lintlane check-commit --message "feat: add login"
npx lintlane check-commit --rev-range origin/main..HEAD
```

Rules come from `commitlint.config.mjs`, which by default is
`export { default } from "lintlane/commitlint"`: Conventional Commits, plus the
optional block below. Replace the file with your own config any time.

```json
{
  "lintlane": {
    "commit": {
      "types": ["feat", "fix", "chore"],
      "messageLengthLimit": 72,
      "allowedPrefixes": ["WIP"]
    }
  }
}
```

The guided prompt is Commitizen's standard `cz-conventional-changelog`.
`lintlane init` adds this adapter configuration to `package.json`:

```json
{
  "config": {
    "commitizen": {
      "path": "lintlane/presets/commitizen.cjs"
    }
  }
}
```

As of **4.1.1**, `lintlane commit` and the guided Git hook resolve this adapter
from lintlane's installation. Existing projects using this configuration need
only upgrade lintlane; no adapter path change is required. Custom adapter paths
are preserved, and `.czrc` and `.cz.json` configuration files are also supported.

## `doctor`

```sh
npx lintlane doctor          # human-readable, with a fix for every problem
npx lintlane doctor --json   # { ok, version, findings: [{ id, status, message, fix? }] }
```

It checks Node, `package.json`, git, the package manager, Biome (and whether it
is installed in the project, where lint-staged looks for it), lintlane, the
bundled tools, Husky and `core.hooksPath`, every hook (current, upgradable,
broken, not executable), lint-staged/commitlint/Commitizen config, your
`lintlane.checks`, and whether the CI workflow runs your checks. Statuses:
`pass`, `warn` (missing or out of date), `fail` (broken). It never changes anything.

## Dashboard (`ui`)

`npx lintlane ui` serves a dashboard on `127.0.0.1` and opens it.

- **Lint tab:** Biome diagnostics by file, the proposed fix as a diff, apply
  fixes per file or all at once. Errors from Biome (can't start, invalid output)
  are shown with the underlying message; a second check can't start while one runs.
- **CI tab:** the same checks as `lintlane run` with live output, per-step status
  and timing, Stop (kills the whole process tree) and stop-on-first-failure.
  Configuration problems and `doctor` failures appear above the table.

### Security

- Listens on loopback only, on a URL carrying a random per-run token; API calls
  need the token in a header (compared in constant time).
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, which
  blocks DNS-rebinding attacks from web pages.
- The page is served with a Content-Security-Policy (per-response script nonce,
  `default-src 'none'`, `frame-ancestors 'none'`), `nosniff` and `no-referrer`.
- The browser sends step ids and file paths, never commands. Paths are resolved
  inside the project and anything outside is refused.
- Only the checks you configured run, with your project's own scripts.

## Presets

| Name                    | Extends path            | Use case                                                                                         |
| ----------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `lintlane/biome`        | `./presets/base.json`   | Default: recommended rules + React domain, warns on unused code/console.                         |
| `lintlane/biome/strict` | `./presets/strict.json` | Base rules raised to errors (unused code, `any`, non-null assertions, console, exhaustive deps). |
| `lintlane/biome/next`   | `./presets/next.json`   | Base preset plus the Next.js lint domain.                                                        |

Presets intentionally don't set `files.includes` — setting it in your own
`biome.json` would _replace_ lintlane's, not merge with it. For Next.js apps,
add your own ignores:

```json
{
  "extends": ["lintlane/biome/next"],
  "files": { "includes": ["**", "!**/.next", "!**/out", "!**/next-env.d.ts"] }
}
```

To migrate an existing config into Biome first:

```sh
npx biome migrate eslint --write
npx biome migrate prettier --write
```

## Migrating from lintlane 3.x

lintlane 4 replaces its own staged-file and commit code with the tools above.

1. Upgrade: `npm install -D lintlane@4` (or your package manager's equivalent).
2. Run `npx lintlane init --dry-run`, then `npx lintlane init`. Untouched 3.x
   hooks are upgraded; a hook you edited is left alone and reported.
3. Run `npx lintlane doctor`.

**Breaking changes**

- `lintlane` now has runtime dependencies (lint-staged, commitlint, Commitizen).
- `bin/pre-commit.mjs`, `commit-msg.mjs`, `prepare-commit-msg.mjs`,
  `pre-push-check.mjs` are gone. Hooks that call them do nothing, which `doctor`
  reports as a failure. `pre-commit.mjs --restore` is gone too: lint-staged
  keeps its own backup stash.
- `lintlane commit` is Commitizen. `--write-message-to-file` and `-l` are gone;
  `--dry-run`, `--retry`, `-a`, `-S` work as in Commitizen, `-- <git args>` as before.
- `check-commit`: `--allow-abort`, `--allowed-prefixes` and `-l` are gone; set
  `lintlane.commit.allowedPrefixes` / `messageLengthLimit` or edit the commitlint config.
- Commit settings `retryAfterFailure` is gone (use `lintlane commit --retry`).
  Custom `types` still apply to commitlint but no longer to the prompt; configure
  the prompt through Commitizen.
- The CI workflow now runs every detected check (typecheck, tests, build), not
  only Biome, and the commit check calls `lintlane check-commit`. Existing
  workflows are not rewritten; turn checks off with `lintlane.checks`.
- Messages are formatted by commitlint, so wording of rejections changed.

## Troubleshooting

Start with `npx lintlane doctor`; each problem comes with a fix.

| Symptom                                                       | Likely cause / fix                                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Hooks don't run                                               | `core.hooksPath` isn't `.husky/_`. Run your package manager's `husky` (via `install`, which runs `prepare`).             |
| "lintlane: node_modules/lintlane not found"                   | Dependencies aren't installed. Run your package manager's install.                                                       |
| `biome: command not found` in pre-commit                      | Biome isn't a dependency of the project. Install `@biomejs/biome`.                                                       |
| lint-staged: "no configuration found"                         | Add a `lint-staged` key (run `init`).                                                                                    |
| commitlint: "Please add rules"                                | Missing `commitlint.config.mjs` (run `init`).                                                                            |
| `lintlane commit` says no adapter configured                  | Add `config.commitizen.path` (run `init`).                                                                               |
| Commitizen cannot resolve `…/lintlane/presets/commitizen.cjs` | Upgrade to lintlane **4.1.1 or newer**. Earlier versions treated the adapter as a path relative to your Git repository.  |
| No prompt on `git commit`                                     | Expected for `-m`, merges, amends, CI, GUI clients, Windows. Use `lintlane commit`.                                      |
| Old hook silently does nothing                                | It calls a 3.x file that no longer exists. `init` upgrades untouched ones; see [Migrating](#migrating-from-lintlane-3x). |
| Dashboard says Forbidden                                      | Open the exact URL printed by `lintlane ui` (it includes the token).                                                     |
| CI doesn't run a check                                        | The workflow predates the check. Add the step, or disable the check under `lintlane.checks`.                             |

### npm deprecation warnings

Installing lintlane can report deprecation warnings for these transitive dependencies:

- `glob@7.2.3` and `inflight@1.0.6`, brought in by Commitizen.
- `git-raw-commits@4.0.0`, brought in by commitlint.

These warnings remain in **4.1.1** and are separate from the commit adapter fix.
They do not by themselves mean installation failed. Check the install exit code
and use `npm audit` to inspect advisories for your installed dependency tree.

## Limitations

- Windows isn't tested. The CLI avoids Unix-only APIs, but the guided prompt on
  `git commit` is skipped there and CI here runs on Ubuntu and macOS only.
- The generated workflow targets GitHub Actions.
- The guided prompt uses the standard Conventional Commits adapter.
- lint-staged and commitlint behavior, including their config discovery, is theirs;
  see their docs for advanced setups (monorepos, per-folder configs).

## Developing lintlane

Requires Node.js 22 or newer.

```sh
npm test                  # unit + integration tests (about 40 seconds, no network)
npm run test:e2e          # real npm / pnpm / yarn / bun installs (needs network)
npm run check             # lint and format this repository
node scripts/verify-release.mjs [npm|pnpm|yarn|bun]   # pack, install in a fresh project, init, doctor, real commits
```

| File                             | What it covers                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `test/hooks.test.mjs`            | Real git: pre-commit (partial staging, failures), commit-msg, prepare-commit-msg, pre-push. |
| `test/setup.test.mjs`            | `init --dry-run`, idempotency, upgrades from 3.x hooks, `doctor`.                           |
| `test/checks.test.mjs`           | The shared checks list, generated CI, `lintlane run`.                                       |
| `test/cli.test.mjs`              | Running on Node without Bun, packaging, `init`. Package managers are **mocked** here.       |
| `test/commit.test.mjs`           | Bundled adapter resolution, custom adapter paths, and forwarding Git arguments.             |
| `test/package-managers.test.mjs` | Package-manager detection and command generation (pure).                                    |
| `test/ui.test.mjs`               | Dashboard: auth, Host/CSP hardening, every API route, Stop.                                 |
| `test/e2e.test.mjs`              | **Real** package managers and the packed tarball. Needs `LINTLANE_E2E=1`.                   |

CI (`.github/workflows/ci.yml`) runs the tests on Ubuntu and macOS with Node 22
and 24, and `verify:release` for each package manager. To try a local build,
set `LINTLANE_INSTALL_SPEC` to a tarball from `npm pack` when running `init`.

## License

MIT

## AI assistants: MCP server and skill

Lintlane includes a local stdio MCP server and a reusable
[Lintlane skill](skills/lintlane/SKILL.md). The server uses the
[official MCP SDK](https://ts.sdk.modelcontextprotocol.io/).
The skill tells an assistant how to diagnose, check, fix, and verify a project;
connecting the server exposes the actual tools.

Configure an MCP-capable host with the following server entry. Replace both
absolute paths with your installed Lintlane and target project paths:

```json
{
  "mcpServers": {
    "lintlane": {
      "command": "node",
      "args": [
        "/absolute/path/to/node_modules/lintlane/bin/mcp.mjs",
        "--project",
        "/absolute/path/to/project",
        "--allow-write"
      ]
    }
  }
}
```

For this source checkout, use `/absolute/path/to/lintlane/bin/mcp.mjs` instead.
After package installation, `lintlane-mcp --project /absolute/path/to/project`
is also available as a binary. No dashboard or HTTP server is needed.

Omit `--allow-write` to disable the fix tool. This flag controls Biome fixes,
not project-script execution: `lintlane_run` can run build, typecheck, and test
scripts, which may write artifacts. Connect only to projects whose scripts you
intend the assistant to execute. The configured project is fixed for the session;
explicit file paths are checked against it, including symlink resolution. This
is a tool boundary, not an OS sandbox for dependencies or repository scripts.

| MCP tool                 | Purpose                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `lintlane_doctor`        | Setup diagnostics with a parsed report and write capability.                 |
| `lintlane_checks`        | Available check IDs, commands, defaults, and configuration problems.         |
| `lintlane_check`         | Biome diagnostics on selected paths, defaulting to `.`.                      |
| `lintlane_fix`           | Supported Biome fixes on explicit paths; requires `--allow-write`.           |
| `lintlane_run`           | Selected `biome`, `typecheck`, `build`, and `test` checks in pipeline order. |
| `lintlane_check_commit`  | Validate a proposed commit message using commitlint.                         |
| `lintlane_preview_setup` | Preview initialization without changing files or installing dependencies.    |

Command results include exit code, stdout, stderr, timeout, and truncation
flags. Calls are serialized, limited to two minutes, and retain at most 256 KiB
of output. A failing check returns an MCP tool error with its diagnostics.
Dependency installation, interactive prompts, and Git mutations are not exposed.
Commitizen remains available through `lintlane commit` in a terminal.

To make the skill discoverable in Codex, copy the `skills/lintlane` directory
from this checkout or the installed package into `~/.codex/skills/lintlane`.
Other hosts can load the same Markdown instructions through their skill system.
The skill does not itself register the MCP server; configure both separately.
Then ask, for example: “Use Lintlane to check the files I changed, fix supported
issues, and run the available typecheck.”
