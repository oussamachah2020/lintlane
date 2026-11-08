// `lintlane doctor` — diagnose the setup. Read-only: it never changes anything.
//
// Each finding is { id, status: "pass" | "warn" | "fail", message, fix? }.
// "fail" means something is broken; "warn" means something is missing or out of
// date but nothing is wrong yet. The exit code is 1 only when there is a fail.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveChecks } from "./checks.mjs";
import { binPath, resolveBiome, resolveTool, runProcess } from "./proc.mjs";
import {
  ciCommand,
  classifyHook,
  detectPackageManager,
  hasCommitlintConfig,
  hasLintStagedConfig,
  installCommand,
} from "./project.mjs";

const HOOK_NAMES = ["pre-commit", "commit-msg", "prepare-commit-msg", "pre-push"];

function major(version) {
  return Number(String(version).replace(/^v/, "").split(".")[0]);
}

export async function runDoctor({ cwd, kitDir }) {
  const findings = [];
  const add = (id, status, message, fix) =>
    findings.push({ id, status, message, ...(fix ? { fix } : {}) });

  const kitPkg = JSON.parse(readFileSync(join(kitDir, "package.json"), "utf8"));
  const minNode = major(String(kitPkg.engines?.node ?? ">=22").replace(/[^\d.]/g, ""));
  if (major(process.version) >= minNode) add("node", "pass", `Node.js ${process.version}`);
  else {
    add(
      "node",
      "fail",
      `Node.js ${process.version}; lintlane needs ${kitPkg.engines.node}`,
      "Upgrade Node.js.",
    );
  }

  const pkgPath = join(cwd, "package.json");
  let pkg = null;
  if (!existsSync(pkgPath)) {
    add(
      "package-json",
      "fail",
      "No package.json in this directory",
      "Run this from your project root.",
    );
  } else {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      add("package-json", "pass", "package.json is valid");
    } catch (error) {
      add("package-json", "fail", `package.json is not valid JSON: ${error.message}`);
    }
  }
  if (!pkg) return finish(findings, kitPkg);

  const pm = detectPackageManager(cwd, pkg);
  const install = (name) => installCommand(pm.name, [name]).join(" ");
  add("package-manager", "pass", `${pm.name} (from ${pm.source})`);

  const git = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd });
  const inRepo = git.code === 0;
  if (inRepo) add("git", "pass", "Inside a git repository");
  else add("git", "warn", "Not a git repository, so hooks can't be installed", "Run `git init`.");

  // Biome
  const biome = resolveBiome(cwd);
  if (!biome) {
    add("biome", "fail", "Biome isn't installed", `Install it: ${install("@biomejs/biome")}`);
  } else {
    const version = await runProcess(biome[0], [...biome.slice(1), "--version"], { cwd });
    const local = existsSync(binPath(cwd, "biome"));
    if (version.code !== 0)
      add("biome", "fail", "Biome is installed but doesn't run", "Reinstall dependencies.");
    else if (!local) {
      add(
        "biome",
        "warn",
        "Biome isn't installed in this project; using the copy next to lintlane, which lint-staged can't find",
        `Install it: ${install("@biomejs/biome")}`,
      );
    } else
      add(
        "biome",
        "pass",
        `Biome ${version.stdout
          .toString()
          .trim()
          .replace(/^Version:\s*/, "")}`,
      );
  }
  if (existsSync(join(cwd, "biome.json")) || existsSync(join(cwd, "biome.jsonc"))) {
    add("biome-config", "pass", "Biome config found");
  } else {
    add("biome-config", "warn", "No biome.json", "Run `lintlane init`.");
  }

  // lintlane itself
  const localKit = join(cwd, "node_modules", "lintlane", "bin", "cli.mjs");
  const isKitRepo = pkg.name === "lintlane";
  if (existsSync(localKit) || isKitRepo)
    add("lintlane-installed", "pass", "lintlane is installed in this project");
  else
    add(
      "lintlane-installed",
      "fail",
      "lintlane isn't installed in this project",
      `Install it: ${install("lintlane")}`,
    );

  // Bundled tools
  for (const [pkgName, bin] of [
    ["lint-staged"],
    ["@commitlint/cli", "commitlint"],
    ["commitizen", "git-cz"],
  ]) {
    add(
      `tool:${pkgName}`,
      resolveTool(pkgName, bin) ? "pass" : "fail",
      resolveTool(pkgName, bin) ? `${pkgName} is available` : `${pkgName} can't be found`,
      resolveTool(pkgName, bin) ? undefined : "Reinstall lintlane.",
    );
  }

  // Git hooks
  if (inRepo) {
    const hooksPath = (
      await runProcess("git", ["config", "--get", "core.hooksPath"], { cwd })
    ).stdout
      .toString()
      .trim();
    const huskyDir = join(cwd, ".husky");
    const hasHooks = HOOK_NAMES.some((name) => existsSync(join(huskyDir, name)));
    if (!hasHooks) {
      add(
        "hooks",
        "warn",
        "No .husky hooks found",
        "Run `lintlane init` (or ignore if you opted out with --no-hooks).",
      );
    } else {
      const huskyDep = pkg.devDependencies?.husky ?? pkg.dependencies?.husky;
      if (!huskyDep)
        add(
          "husky",
          "fail",
          "Hooks exist but husky isn't a dependency",
          `Install it: ${install("husky")}`,
        );
      else add("husky", "pass", `husky ${huskyDep}`);

      if (/husky/.test(pkg.scripts?.prepare ?? ""))
        add("prepare-script", "pass", '"prepare" script runs husky');
      else
        add(
          "prepare-script",
          "warn",
          'No "prepare" script running husky, so teammates won\'t get hooks on install',
          'Add "prepare": "husky".',
        );

      if (/(^|\/)\.husky(\/_)?$/.test(hooksPath))
        add("hooks-path", "pass", `core.hooksPath = ${hooksPath}`);
      else {
        add(
          "hooks-path",
          "fail",
          `git isn't using .husky (core.hooksPath = ${hooksPath || "unset"})`,
          `Run: ${pm.name === "npm" ? "npx" : pm.name === "bun" ? "bunx" : `${pm.name} exec`} husky`,
        );
      }

      for (const name of HOOK_NAMES) {
        const hookPath = join(huskyDir, name);
        const templatePath = join(kitDir, "templates", name);
        if (!existsSync(hookPath)) {
          if (name === "pre-commit")
            add(`hook:${name}`, "fail", ".husky/pre-commit is missing", "Run `lintlane init`.");
          else
            add(
              `hook:${name}`,
              "warn",
              `.husky/${name} is missing`,
              "Run `lintlane init` (or ignore if you opted out with --no-commit-lint).",
            );
          continue;
        }
        const state = classifyHook(
          name,
          readFileSync(hookPath, "utf8"),
          readFileSync(templatePath, "utf8"),
        );
        const executable = process.platform === "win32" || (statSync(hookPath).mode & 0o111) !== 0;
        if (state === "legacy") {
          add(
            `hook:${name}`,
            "fail",
            `.husky/${name} is from an older lintlane and no longer does anything`,
            "Run `lintlane init` to upgrade it.",
          );
        } else if (state === "stale" || state === "unsafe") {
          add(
            `hook:${name}`,
            "fail",
            `.husky/${name} calls files lintlane no longer ships`,
            `Replace its contents with node_modules/lintlane/templates/${name}.`,
          );
        } else if (!executable) {
          add(`hook:${name}`, "fail", `.husky/${name} isn't executable`, `chmod +x .husky/${name}`);
        } else {
          add(
            `hook:${name}`,
            "pass",
            state === "current" ? `.husky/${name} is up to date` : `.husky/${name} is customized`,
          );
        }
      }
    }
    if (existsSync(join(git.stdout.toString().trim(), ".git", "lintlane-backup"))) {
      add(
        "old-backup",
        "warn",
        "Leftover .git/lintlane-backup from lintlane < 4 (an interrupted old hook run)",
        "Check its files for unsaved work, then delete the folder.",
      );
    }
  }

  // Staged files + commits
  if (hasLintStagedConfig(cwd, pkg)) add("lint-staged-config", "pass", "lint-staged is configured");
  else
    add(
      "lint-staged-config",
      "warn",
      "No lint-staged configuration; the pre-commit hook has nothing to run",
      "Run `lintlane init`.",
    );

  if (hasCommitlintConfig(cwd, pkg)) add("commitlint-config", "pass", "commitlint is configured");
  else
    add(
      "commitlint-config",
      "warn",
      "No commitlint configuration; commit messages aren't validated",
      "Run `lintlane init`.",
    );

  const czPath = pkg.config?.commitizen?.path;
  if (czPath) add("commitizen-config", "pass", `Commitizen adapter: ${czPath}`);
  else
    add(
      "commitizen-config",
      "warn",
      "No Commitizen adapter; `lintlane commit` can't prompt",
      "Run `lintlane init`.",
    );

  // Checks + CI
  if (biome) {
    const { steps, problems } = resolveChecks({ cwd, biome, pmName: pm.name, pkg });
    for (const problem of problems) add("checks-config", "warn", problem);
    if (problems.length === 0) {
      add(
        "checks",
        "pass",
        `Checks: ${steps
          .filter((s) => s.defaultOn)
          .map((s) => s.id)
          .join(", ")}`,
      );
    }
    const ciPath = join(cwd, ".github", "workflows", "biome.yml");
    if (existsSync(ciPath)) {
      const workflow = readFileSync(ciPath, "utf8");
      const missing = steps
        .filter((step) => step.ci)
        .map((step) => ciCommand(pm.name, step))
        .filter((command) => command && !workflow.includes(command));
      if (missing.length === 0)
        add("ci", "pass", ".github/workflows/biome.yml matches your checks");
      else
        add(
          "ci",
          "warn",
          `CI workflow doesn't run: ${missing.join(", ")}`,
          "Add those steps, or turn the check off in package.json under lintlane.checks.",
        );
    } else {
      add(
        "ci",
        "warn",
        "No .github/workflows/biome.yml",
        "Run `lintlane init` (or ignore if you opted out with --no-ci).",
      );
    }
  }

  return finish(findings, kitPkg);
}

function finish(findings, kitPkg) {
  return {
    ok: !findings.some((finding) => finding.status === "fail"),
    version: kitPkg.version,
    findings,
  };
}

const ICONS = { pass: "✔", warn: "!", fail: "✘" };

export function formatReport(report) {
  const lines = [`lintlane doctor (v${report.version})`, ""];
  for (const f of report.findings) {
    lines.push(`${ICONS[f.status]} ${f.message}`);
    if (f.fix && f.status !== "pass") lines.push(`    → ${f.fix}`);
  }
  const fails = report.findings.filter((f) => f.status === "fail").length;
  const warns = report.findings.filter((f) => f.status === "warn").length;
  lines.push(
    "",
    fails || warns ? `${fails} problem(s), ${warns} warning(s).` : "Everything looks good.",
  );
  return lines.join("\n");
}
