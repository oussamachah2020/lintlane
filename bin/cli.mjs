#!/usr/bin/env node
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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
  console.error(`✘ ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`✔ ${message}`);
}

function warn(message) {
  console.log(`! ${message}`);
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
      console.log(`${step.id.padEnd(10)} ${step.defaultOn ? "on " : "off"}  ${step.display}`);
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
      if (event.type === "start")
        console.log(`▶ ${byId.get(event.id).label}  (${byId.get(event.id).display})`);
      else if (event.type === "log") process.stdout.write(event.text);
      else if (event.type === "end") {
        results.push(event);
        console.log(
          `${event.code === 0 ? "✔" : "✘"} ${byId.get(event.id).label} (${(event.ms / 1000).toFixed(1)}s)`,
        );
      } else if (event.type === "skip") console.log(`- skipped ${byId.get(event.id).label}`);
    },
  });
  process.exit(
    results.every((result) => result.code === 0) && results.length === chosen.length ? 0 : 1,
  );
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

let pkg = await readJson(pkgPath);
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
if (dryRun) console.log("Dry run: nothing will be changed.\n");

// Every change goes through act(): in a dry run it only says what it would do.
async function act(message, fn) {
  if (dryRun) {
    console.log(`+ would ${message}`);
    return;
  }
  await fn();
  ok(message[0].toUpperCase() + message.slice(1));
}

// LINTLANE_INSTALL_SPEC lets you install lintlane from somewhere other than the
// registry (a tarball from `npm pack`, a local folder) when testing a build.
const kitSpec = process.env.LINTLANE_INSTALL_SPEC || `${KIT_NAME}@${KIT_VERSION}`;
const declared = { ...pkg.dependencies, ...pkg.devDependencies };
// Only install what's missing, so an existing Biome or husky version is never bumped.
const devPackages = [];
if (!("@biomejs/biome" in declared)) devPackages.push("@biomejs/biome");
if (process.env.LINTLANE_INSTALL_SPEC || !(KIT_NAME in declared))
  devPackages.push(kitSpec);
if (!values["no-hooks"] && !("husky" in declared)) devPackages.push("husky");

if (devPackages.length === 0) {
  ok("Dependencies already installed");
} else if (values["skip-install"] || dryRun) {
  const argv = installCommand(pmName, devPackages).join(" ");
  if (dryRun) console.log(`+ would run: ${argv}`);
  else warn(`Skipped install. Run: ${argv}`);
} else {
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
  // The install just rewrote package.json (devDependencies). Re-read it, or the
  // scripts we add below would be written over a stale copy and erase those entries.
  pkg = await readJson(pkgPath);
}

const biomeJsonPath = join(cwd, "biome.json");
const biomeJsoncPath = join(cwd, "biome.jsonc");
const extendsSpecifier = `${KIT_NAME}/${PRESET_PATHS[preset]}`;

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
    writeFile(biomeJsonPath, `${JSON.stringify(config, null, 2)}\n`),
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
  if (dryRun) console.log(`+ would ${message} in package.json`);
}
if (pkgEdits.length > 0 && !dryRun) {
  for (const edit of pkgEdits) edit();
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  for (const message of pending.filter(Boolean))
    ok(`${message[0].toUpperCase()}${message.slice(1)}`);
}

// commitlint config
if (!values["no-commit-lint"]) {
  if (hasCommitlintConfig(cwd, pkg)) {
    warn("commitlint is already configured — left untouched");
  } else {
    await act("write commitlint.config.mjs", () =>
      writeFile(
        join(cwd, "commitlint.config.mjs"),
        'export { default } from "lintlane/commitlint";\n',
      ),
    );
  }
}

if (!values["no-hooks"]) {
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
        await mkdir(huskyDir, { recursive: true });
        await writeFile(hookPath, template);
        await chmod(hookPath, 0o755);
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
              : "") +
            `. Replace its contents with node_modules/lintlane/templates/${hook}.`,
        );
      } else {
        warn(`.husky/${hook} already exists — left untouched`);
      }
    }

    if (wroteHook) {
      if (values["skip-install"]) {
        warn("Skipped: run `node_modules/.bin/husky` to finish git hooks setup");
      } else {
        const husky = binPath(cwd, "husky");
        if (existsSync(husky)) {
          const ran = await runProcess(husky, [], { cwd });
          if (ran.code === 0) ok("Ran husky");
          else warn(`husky failed: ${(ran.stderr.toString() || ran.error?.message || "").trim()}`);
        } else {
          warn(`husky binary not found at ${husky} — run it manually once installed`);
        }
      }
    } else if (dryRun) {
      console.log("+ would run husky to point git at .husky");
    }
  }
}

if (!values["no-ci"]) {
  const workflowsDir = join(cwd, ".github", "workflows");
  const ciPath = join(workflowsDir, "biome.yml");
  if (existsSync(ciPath)) {
    warn(
      ".github/workflows/biome.yml already exists — left untouched (run `lintlane doctor` to compare it with your checks)",
    );
  } else {
    const withCommitCheck = !values["no-commit-lint"] && !values["no-hooks"];
    const biomeArgv = resolveBiome(cwd) ?? ["biome"];
    const { steps: checks } = resolveChecks({ cwd, biome: biomeArgv, pmName, pkg });
    await act("write .github/workflows/biome.yml", async () => {
      await mkdir(workflowsDir, { recursive: true });
      await writeFile(
        ciPath,
        renderWorkflow({ pmName, kitName: KIT_NAME, withCommitCheck, checks }),
      );
    });
  }
}

console.log(
  dryRun
    ? "\nDry run finished. Run again without --dry-run to apply."
    : `\nRun: ${pmName} run check:fix   (and \`${RUNNER} ${KIT_NAME} doctor\` to verify the setup)`,
);
