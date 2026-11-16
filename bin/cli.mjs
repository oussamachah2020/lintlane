#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { diffStringsUnified } from "jest-diff";
import { resolveChecks } from "./checks.mjs";
import { binPath, resolveBiome, runInherit, runProcess } from "./proc.mjs";
import {
  COMMITIZEN_PATH,
  classifyHook,
  detectPackageManager,
  detectPreset,
  hasCommitlintConfig,
  hasLintStagedConfig,
  installCommand,
  LINT_STAGED_CONFIG,
  PRESET_PATHS,
  renderWorkflow,
  runnerCommand,
} from "./project.mjs";
import { c, header, line, SYMBOLS, section } from "./style.mjs";

const KIT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const KIT_PKG = await readJson(join(KIT_DIR, "package.json"));
const KIT_NAME = KIT_PKG.name;
const KIT_VERSION = KIT_PKG.version;
const RUNNER = runnerCommand();

const BIOME_SUBCOMMANDS = {
  check: (paths) => ["check", ...paths],
  "check:fix": (paths) => ["check", "--write", ...paths],
  ci: (paths) => ["ci", "--reporter=github", ...paths],
};

const HELP = `Usage: ${RUNNER} ${KIT_NAME} <command> [options]

Commands:
  init-tests       Set up unit, component and browser tests
  init [options]   Set up Biome, scripts, hooks, and CI in the current project
  check [paths]     Run biome check (defaults to .)
  check:fix [paths] Run biome check --write (defaults to .)
  ci [paths]        Run biome ci --reporter=github (defaults to .)
  run [checks]      Run the project's checks (Biome, typecheck, build, tests) in
                    order, the same list CI and the dashboard use. Flags:
                    --keep-going (don't stop at the first failure), --list
  doctor [--json]   Diagnose the setup: tools, hooks, configs, CI. Read-only
  commit [options]  Guided Conventional Commit (alias: c), run by Commitizen;
                    git flags go after --
  check-commit      Validate commit messages with commitlint (--message,
                    --commit-msg-file, --rev-range, -d)
  ui [options]      Open the local dashboard: run checks, review errors and
                    proposed fixes as a diff, apply fixes per file

ui options:
  --port <n>                   Port to listen on (default: 4321)
  --no-open                    Don't open the browser automatically

init options:
  --preset <base|strict|next>  Which preset to extend (default: auto-detected)
  --no-hooks                   Skip husky + pre-commit hook setup
  --no-commit-lint             Skip the commit-message hooks (commit-msg, prepare-commit-msg, pre-push)
  --no-ci                      Skip the GitHub Actions workflow
  --dry-run                    Show everything init would do; change nothing
  -y, --yes                    Approve the displayed plan without prompting
  --skip-install                Print install commands instead of running them
  -h, --help                   Show this help

Without --preset, init reads your package.json dependencies and picks for
you: Next.js -> "next" preset; React, TanStack Start, React Router
(framework mode), or Remix -> "base" preset (they're all React under the
hood, and only Next.js has its own Biome lint domain). "strict" is never
auto-selected — pass --preset strict explicitly when you want it.

check / check:fix / ci run the Biome binary already installed in this
project's node_modules — you never need to call biome yourself. The
package manager (npm, pnpm, yarn, or bun) used by \`init\` is detected from
the "packageManager" field in package.json, then from whichever lockfile is
present, then from the tool you launched lintlane with (npx, pnpm dlx, yarn
dlx, bunx). npm is used when none of those apply.

After \`init\` the \`lintlane\` command is installed in your project, for
example: \`npx lintlane check\`, \`pnpm exec lintlane check\`,
\`yarn lintlane check\`, \`bunx lintlane check\`.
`;

function fail(message) {
  const [first, ...rest] = String(message).split("\n");
  console.error(`\n  ${SYMBOLS.fail} ${c.red(first)}`);
  for (const more of rest) console.error(`    ${c.dim(more)}`);
  process.exit(1);
}

function ok(message, hint) {
  line(SYMBOLS.ok, message, hint);
}

function warn(message, hint) {
  line(SYMBOLS.warn, message, hint);
}

// Everything after a bare "--" belongs to the subcommand (e.g. `commit -- -a -S`
// hands "-a -S" to git commit), so it never reaches our own option parsing.
const rawArgs = process.argv.slice(2);
const doubleDash = rawArgs.indexOf("--");
const ownArgs = doubleDash < 0 ? rawArgs : rawArgs.slice(0, doubleDash);
const passthroughArgs = doubleDash < 0 ? [] : rawArgs.slice(doubleDash + 1);

const { values, positionals } = parseArgs({
  args: ownArgs,
  options: {
    yes: { type: "boolean", short: "y", default: false },
    preset: { type: "string" },
    "no-hooks": { type: "boolean", default: false },
    "no-ci": { type: "boolean", default: false },
    "no-commit-lint": { type: "boolean", default: false },
    "skip-install": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "keep-going": { type: "boolean", default: false },
    list: { type: "boolean", default: false },
    port: { type: "string" },
    "no-open": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
  strict: false,
});

const command = positionals[0] ?? "init";
const cwd = process.cwd();
const commandArgs = ownArgs.slice(ownArgs.indexOf(command) + 1);

// `commit -h` and `check-commit -h` show their own help; everything else the main one.
if (values.help && !["commit", "c", "check-commit"].includes(command)) {
  console.log(HELP);
  process.exit(0);
}

if (command in BIOME_SUBCOMMANDS) {
  const biome = resolveBiome(cwd);
  if (!biome) {
    fail(`Biome isn't installed in this project. Run: ${RUNNER} ${KIT_NAME} init`);
  }
  const extraPaths = positionals.slice(1);
  const biomeArgs = BIOME_SUBCOMMANDS[command](extraPaths.length ? extraPaths : ["."]);
  process.exit(await runInherit(biome[0], [...biome.slice(1), ...biomeArgs], { cwd }));
}

if (command === "commit" || command === "c") {
  const { runCommit } = await import("./commit-cli.mjs");
  process.exit(await runCommit({ argv: commandArgs, gitArgs: passthroughArgs, cwd }));
}

if (command === "check-commit") {
  const { main } = await import("./check-commit.mjs");
  process.exit(await main(commandArgs, cwd));
}

if (command === "doctor") {
  const { formatReport, runDoctor } = await import("./doctor.mjs");
  const report = await runDoctor({ cwd, kitDir: KIT_DIR });
  console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  process.exit(report.ok ? 0 : 1);
}

if (command === "hook") {
  const { runHook } = await import("./hook.mjs");
  const at = rawArgs.indexOf("hook");
  const [name, ...hookArgs] = rawArgs.slice(at + 1);
  process.exit(await runHook(name, hookArgs, cwd));
}

if (command === "run") {
  const biome = resolveBiome(cwd);
  if (!biome) fail(`Biome isn't installed in this project. Run: ${RUNNER} ${KIT_NAME} init`);
  const pkg = existsSync(join(cwd, "package.json"))
    ? await readJson(join(cwd, "package.json"))
    : {};
  const { steps, problems } = resolveChecks({
    cwd,
    biome,
    pmName: detectPackageManager(cwd, pkg).name,
    pkg,
  });
  for (const problem of problems) warn(problem);
  if (values.list) {
    for (const step of steps) {
      const state = step.defaultOn ? c.green("on ") : c.gray("off");
      console.log(`${c.bold(step.id.padEnd(10))} ${state}  ${c.dim(step.display)}`);
    }
    process.exit(0);
  }
  const wanted = positionals.slice(1);
  const unknown = wanted.filter((id) => !steps.some((step) => step.id === id));
  if (unknown.length)
    fail(`Unknown check: ${unknown.join(", ")}. Available: ${steps.map((st) => st.id).join(", ")}`);
  const chosen = wanted.length
    ? steps.filter((step) => wanted.includes(step.id))
    : steps.filter((step) => step.defaultOn);
  if (chosen.length === 0) fail("No checks to run.");
  const { runCiSteps } = await import("./checks.mjs");
  const results = [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  await runCiSteps({
    cwd,
    steps: chosen,
    stopOnFail: !values["keep-going"],
    send: (event) => {
      const step = byId.get(event.id);
      if (event.type === "start")
        console.log(`\n${SYMBOLS.step} ${c.bold(step.label)}  ${c.dim(step.display)}`);
      else if (event.type === "log") process.stdout.write(event.text);
      else if (event.type === "end") {
        results.push(event);
        const time = c.dim(`(${(event.ms / 1000).toFixed(1)}s)`);
        console.log(
          event.code === 0
            ? `${SYMBOLS.ok} ${c.green(step.label)} ${time}`
            : `${SYMBOLS.fail} ${c.red(step.label)} ${time}`,
        );
      } else if (event.type === "skip")
        console.log(`${SYMBOLS.skip} ${c.gray(`skipped ${step.label}`)}`);
    },
  });
  const passed = results.filter((result) => result.code === 0).length;
  const allPassed = passed === chosen.length && results.length === chosen.length;
  console.log(
    `\n${allPassed ? c.green(`All ${passed} checks passed`) : c.red(`${passed}/${chosen.length} checks passed`)}`,
  );
  process.exit(allPassed ? 0 : 1);
}

if (command === "ui") {
  const biome = resolveBiome(cwd);
  if (!biome) {
    fail(`Biome isn't installed in this project. Run: ${RUNNER} ${KIT_NAME} init`);
  }
  const { startUi } = await import("./ui-server.mjs");
  const uiPkgPath = join(cwd, "package.json");
  const uiPkg = existsSync(uiPkgPath) ? await readJson(uiPkgPath) : {};
  try {
    await startUi({
      cwd,
      biome,
      pkg: uiPkg,
      pmName: detectPackageManager(cwd, uiPkg).name,
      kitDir: KIT_DIR,
      port: values.port === undefined ? 4321 : Number(values.port),
      open: !values["no-open"],
    });
  } catch (error) {
    fail(error.message);
  }
  await new Promise(() => {});
}

if (command === "init-tests") {
  try {
    await (await import("./init-tests.mjs")).initTests(cwd, values);
  } catch (error) {
    fail(error.message);
  }
  process.exit(0);
}

if (command !== "init") {
  fail(
    `Unknown command "${command}". Usage: ${RUNNER} ${KIT_NAME} <init|check|check:fix|ci|run|doctor|commit|check-commit|ui> [options]`,
  );
}

if (values.preset !== undefined && !(values.preset in PRESET_PATHS)) {
  fail(
    `Invalid preset "${values.preset}". Valid presets: ${Object.keys(PRESET_PATHS).join(", ")}.`,
  );
}

const pkgPath = join(cwd, "package.json");
if (!existsSync(pkgPath)) {
  fail("No package.json found in the current directory.");
}

const pkg = await readJson(pkgPath);
header(KIT_NAME, KIT_VERSION, values["dry-run"] ? "init (dry run)" : "init");
if (values["dry-run"]) console.log(`  ${c.dim("Dry run: nothing will be changed.")}`);
section("Project");
const { name: pmName, source: pmSource } = detectPackageManager(cwd, pkg);
ok(`Detected package manager: ${pmName} (${pmSource})`);

let preset = values.preset;
if (preset === undefined) {
  const detected = detectPreset(pkg);
  preset = detected.preset;
  if (detected.label) {
    ok(`Detected ${detected.label} — using preset "${preset}"`);
  } else {
    warn(`No known framework detected — using preset "${preset}" (pass --preset to choose)`);
  }
}

const dryRun = values["dry-run"];

const actions = [];
const files = [];
const originalPkg = await readFile(pkgPath, "utf8");
const existingLint =
  readdirSync(cwd).some((name) =>
    /^(biome\.jsonc?|eslint\.config\..+|\.eslintrc(?:\..+)?|\.prettierrc(?:\..+)?|prettier\.config\..+|\.oxlintrc\.json|deno\.jsonc?)$/.test(
      name,
    ),
  ) ||
  Boolean(pkg.eslintConfig || pkg.prettier || hasLintStagedConfig(cwd, pkg)) ||
  Object.entries(pkg.scripts ?? {}).some(
    ([name, value]) =>
      /^(lint|format|check)(:|$)/.test(name) ||
      /\b(eslint|biome|prettier|oxlint|standard)\b/.test(value),
  ) ||
  Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((name) =>
    ["@biomejs/biome", "eslint", "prettier", "oxlint", "standard"].includes(name),
  );

async function planFile(path, content) {
  const before = existsSync(path) ? await readFile(path, "utf8") : null;
  if (before !== content) files.push({ path, before, content });
}

// Plan first: no writes, installs or hook activation until approval.
async function act(message, fn) {
  if (dryRun) {
    line(SYMBOLS.plan, `would ${message}`);
    await fn();
    return;
  }
  await fn();
  actions.push(async () => {
    ok(message[0].toUpperCase() + message.slice(1));
  });
}

// LINTLANE_INSTALL_SPEC lets you install lintlane from somewhere other than the
// registry (a tarball from `npm pack`, a local folder) when testing a build.
const kitSpec = process.env.LINTLANE_INSTALL_SPEC || `${KIT_NAME}@${KIT_VERSION}`;
const declared = { ...pkg.dependencies, ...pkg.devDependencies };
// Only install what's missing, so an existing Biome or husky version is never bumped.
const devPackages = [];
if (!("@biomejs/biome" in declared)) devPackages.push("@biomejs/biome");
if (process.env.LINTLANE_INSTALL_SPEC || !(KIT_NAME in declared)) devPackages.push(kitSpec);
if (!values["no-hooks"] && !("husky" in declared)) devPackages.push("husky");

if (devPackages.length === 0) {
  ok("Dependencies already installed");
} else if (values["skip-install"] || dryRun) {
  const argv = installCommand(pmName, devPackages).join(" ");
  if (dryRun) line(SYMBOLS.plan, `would run: ${argv}`);
  else warn("Skipped install", `Run: ${argv}`);
} else {
  actions.push(async () => {
    const installArgv = installCommand(pmName, devPackages);
    const install = await runProcess(installArgv[0], installArgv.slice(1), { cwd });
    if (install.code !== 0) {
      const reason =
        install.error?.code === "ENOENT"
          ? `"${installArgv[0]}" was not found. Install it, or run again with --skip-install and install the packages yourself:\n  ${installArgv.join(" ")}`
          : (install.stderr.toString().trim() || install.stdout.toString().trim())
              .split("\n")
              .slice(-8)
              .join("\n");
      fail(`Install failed (${installArgv.join(" ")}):\n${reason}`);
    }
    ok(`Installed ${devPackages.join(", ")}`);
  });
}

const biomeJsonPath = join(cwd, "biome.json");
const biomeJsoncPath = join(cwd, "biome.jsonc");
const extendsSpecifier = `${KIT_NAME}/${PRESET_PATHS[preset]}`;
section("Configuration");

if (existsSync(biomeJsonPath) || existsSync(biomeJsoncPath)) {
  warn(`biome.json already exists — make sure its "extends" includes "${extendsSpecifier}"`);
} else {
  const config = {
    $schema: "./node_modules/@biomejs/biome/configuration_schema.json",
    extends: [extendsSpecifier],
  };
  if (preset === "next") {
    config.files = { includes: ["**", "!**/.next", "!**/out", "!**/next-env.d.ts"] };
  }
  await act(`write biome.json (extends ${extendsSpecifier})`, () =>
    planFile(biomeJsonPath, `${JSON.stringify(config, null, 2)}\n`),
  );
}

// package.json: scripts, lint-staged, Commitizen. Only ever adds what's missing.
pkg.scripts ??= {};
const pkgEdits = [];
const addScript = (name, value) => {
  if (!pkg.scripts[name]) {
    pkgEdits.push(() => {
      pkg.scripts[name] = value;
    });
    return `add script "${name}"`;
  }
  warn(`Script "${name}" already exists — left untouched`);
  return null;
};
const pending = [
  addScript("check", "biome check ."),
  addScript("check:fix", "biome check --write ."),
];

if (!values["no-hooks"]) {
  if (!pkg.scripts.prepare) pending.push(addScript("prepare", "husky"));
  else if (!pkg.scripts.prepare.includes("husky")) {
    pkgEdits.push(() => {
      pkg.scripts.prepare = `${pkg.scripts.prepare} && husky`;
    });
    pending.push('append husky to the existing "prepare" script');
  } else {
    warn('Script "prepare" already runs husky — left untouched');
  }

  if (hasLintStagedConfig(cwd, pkg)) {
    warn("lint-staged is already configured — left untouched");
  } else {
    pkgEdits.push(() => {
      pkg["lint-staged"] = LINT_STAGED_CONFIG;
    });
    pending.push('add "lint-staged" config (Biome on staged files)');
  }
}

if (!values["no-commit-lint"]) {
  if (pkg.config?.commitizen?.path) {
    warn("Commitizen is already configured — left untouched");
  } else {
    pkgEdits.push(() => {
      pkg.config = {
        ...pkg.config,
        commitizen: { ...pkg.config?.commitizen, path: COMMITIZEN_PATH },
      };
    });
    pending.push('add "config.commitizen" (guided commits)');
  }
}

for (const message of pending.filter(Boolean)) {
  if (dryRun) line(SYMBOLS.plan, `would ${message} in package.json`);
}
if (pkgEdits.length > 0) {
  for (const edit of pkgEdits) edit();
  await planFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  for (const message of pending.filter(Boolean))
    if (!dryRun) actions.push(async () => ok(`${message[0].toUpperCase()}${message.slice(1)}`));
}

// commitlint config
if (!values["no-commit-lint"]) {
  if (hasCommitlintConfig(cwd, pkg)) {
    warn("commitlint is already configured — left untouched");
  } else {
    await act("write commitlint.config.mjs", () =>
      planFile(
        join(cwd, "commitlint.config.mjs"),
        'export { default } from "lintlane/commitlint";\n',
      ),
    );
  }
}

if (!values["no-hooks"]) {
  section("Git hooks");
  const gitDir = join(cwd, ".git");
  if (!existsSync(gitDir)) {
    warn("No .git directory found — skipping husky hook setup");
  } else {
    const huskyDir = join(cwd, ".husky");
    const hooks = ["pre-commit"];
    if (!values["no-commit-lint"]) hooks.push("commit-msg", "prepare-commit-msg", "pre-push");
    let wroteHook = false;

    for (const hook of hooks) {
      const hookPath = join(huskyDir, hook);
      const template = await readFile(join(KIT_DIR, "templates", hook), "utf8");
      const writeHook = async () => {
        await planFile(hookPath, template);
        wroteHook = true;
      };
      if (!existsSync(hookPath)) {
        await act(`write .husky/${hook}`, writeHook);
        continue;
      }
      const state = classifyHook(hook, await readFile(hookPath, "utf8"), template);
      if (state === "current") {
        ok(`.husky/${hook} is up to date`);
      } else if (state === "legacy") {
        // Untouched hook from an older lintlane; the files it called are gone.
        await act(`upgrade .husky/${hook} (the old one is from an earlier lintlane)`, writeHook);
      } else if (state === "stale" || state === "unsafe") {
        warn(
          `.husky/${hook} was edited and still calls files lintlane no longer ships` +
            (state === "unsafe"
              ? " (and `git update-index --again` can stage changes you didn't stage)"
              : ""),
          `Replace its contents with node_modules/lintlane/templates/${hook}.`,
        );
      } else {
        warn(`.husky/${hook} already exists — left untouched`);
      }
    }

    actions.push(async () => {
      if (wroteHook) {
        if (values["skip-install"]) {
          warn("Skipped husky", "Run `node_modules/.bin/husky` to finish git hooks setup");
        } else {
          const husky = binPath(cwd, "husky");
          if (existsSync(husky)) {
            const ran = await runProcess(husky, [], { cwd });
            if (ran.code === 0) ok("Ran husky");
            else
              warn(`husky failed: ${(ran.stderr.toString() || ran.error?.message || "").trim()}`);
          } else {
            warn(`husky binary not found at ${husky}`, "Run it manually once installed");
          }
        }
      } else if (dryRun) {
        line(SYMBOLS.plan, "would run husky to point git at .husky");
      }
    });
  }
}

if (!values["no-ci"]) {
  section("CI");
  const workflowsDir = join(cwd, ".github", "workflows");
  const ciPath = join(workflowsDir, "biome.yml");
  if (existsSync(ciPath)) {
    warn(
      ".github/workflows/biome.yml already exists — left untouched",
      "Run `lintlane doctor` to compare it with your checks",
    );
  } else {
    const withCommitCheck = !values["no-commit-lint"] && !values["no-hooks"];
    const biomeArgv = resolveBiome(cwd) ?? ["biome"];
    const { steps: checks } = resolveChecks({ cwd, biome: biomeArgv, pmName, pkg });
    await act("write .github/workflows/biome.yml", async () => {
      await planFile(
        ciPath,
        renderWorkflow({ pmName, kitName: KIT_NAME, withCommitCheck, checks }),
      );
    });
  }
}

if (existingLint || dryRun) {
  if (files.length) section(`Proposed changes ${c.dim("(existing configs are preserved)")}`);
  for (const { path, before, content } of files) {
    const name = path.slice(cwd.length + 1);
    console.log(
      diffStringsUnified(before ?? "", content, {
        aAnnotation: before === null ? "/dev/null" : `a/${name}`,
        bAnnotation: `b/${name}`,
        expand: false,
        contextLines: 3,
        includeChangeCounts: true,
      }),
    );
  }
  if (devPackages.length && !values["skip-install"]) {
    section("Install");
    console.log(`  ${c.cyan(installCommand(pmName, devPackages).join(" "))}`);
    console.log(
      `  ${c.dim("The package manager will also update dependencies and its lockfile and may run lifecycle scripts.")}`,
    );
  }
}

if (!dryRun && existingLint && !values.yes) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(
      `\n  ${c.yellow("Nothing changed.")} ${c.dim("Review with --dry-run, then pass --yes to approve in a noninteractive session.")}`,
    );
    process.exit(1);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    const question =
      files.length || devPackages.length
        ? "Apply these changes and run the listed install?"
        : "Everything is in place. Finish setup?";
    answer = await prompt.question(`\n  ${c.cyan("?")} ${c.bold(question)} ${c.dim("(y/N)")} `);
  } finally {
    prompt.close();
  }
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log(`  ${c.dim("Nothing changed.")}`);
    process.exit(0);
  }
}

if (!dryRun) {
  // Refuse to apply a stale review if a file changed while the prompt was open.
  for (const { path, before } of files) {
    const current = existsSync(path) ? await readFile(path, "utf8") : null;
    if (current !== before) fail(`${path} changed during review. Run init again.`);
  }
  // Install first, preserving the dependency edits made by the package manager.
  const installAction = devPackages.length && !values["skip-install"] ? actions.shift() : null;
  if (files.length || installAction) section("Applying");
  if (installAction) await installAction();
  for (const { path, content } of files) {
    let next = content;
    if (path === pkgPath && installAction) {
      const installed = await readJson(pkgPath);
      const planned = JSON.parse(content);
      const original = JSON.parse(originalPkg);
      for (const key of ["scripts", "lint-staged", "config"]) {
        if (JSON.stringify(planned[key]) !== JSON.stringify(original[key]))
          installed[key] = planned[key];
      }
      next = `${JSON.stringify(installed, null, 2)}\n`;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, next);
    if (path.startsWith(`${join(cwd, ".husky")}/`)) await chmod(path, 0o755);
  }
  for (const action of actions) await action();
}

if (dryRun) {
  console.log(
    `\n  ${c.bold("Dry run finished.")} ${c.dim("Run again without --dry-run to apply.")}\n`,
  );
} else {
  console.log(`\n  ${c.green(c.bold("Done."))} Next steps:`);
  console.log(`    ${c.cyan(`${pmName} run check:fix`)}   ${c.dim("fix what Biome can fix")}`);
  console.log(`    ${c.cyan(`${RUNNER} ${KIT_NAME} doctor`)}   ${c.dim("verify the setup")}\n`);
}
