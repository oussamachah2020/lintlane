// Project detection and generated-file rendering used by `lintlane init`:
// package manager, framework preset, install commands, the CI workflow.
// Pure functions where possible, so they can be tested without a package manager.
import { existsSync } from "node:fs";
import { join } from "node:path";

export const PRESET_PATHS = {
  base: "biome",
  strict: "biome/strict",
  next: "biome/next",
};

// Node 20 left maintenance in April 2026; the generated workflows use 22.
const NODE_VERSION = 22;

export const PACKAGE_MANAGERS = {
  bun: {
    lockfiles: ["bun.lock", "bun.lockb"],
    install: (pkgs) => ["bun", "add", "--dev", "--exact", ...pkgs],
    runCheckCi: "bunx biome ci --reporter=github .",
    setupSteps: [
      "      - uses: oven-sh/setup-bun@v2",
      "      - run: bun install --frozen-lockfile",
    ],
  },
  npm: {
    lockfiles: ["package-lock.json", "npm-shrinkwrap.json"],
    install: (pkgs) => ["npm", "install", "--save-dev", "--save-exact", ...pkgs],
    runCheckCi: "npx biome ci --reporter=github .",
    setupSteps: [
      "      - uses: actions/setup-node@v4",
      "        with:",
      `          node-version: ${NODE_VERSION}`,
      "          cache: npm",
      "      - run: npm ci",
    ],
  },
  pnpm: {
    lockfiles: ["pnpm-lock.yaml"],
    install: (pkgs) => ["pnpm", "add", "--save-dev", "--save-exact", ...pkgs],
    runCheckCi: "pnpm exec biome ci --reporter=github .",
    setupSteps: [
      "      - uses: pnpm/action-setup@v4",
      "      - uses: actions/setup-node@v4",
      "        with:",
      `          node-version: ${NODE_VERSION}`,
      "          cache: pnpm",
      "      - run: pnpm install --frozen-lockfile",
    ],
  },
  yarn: {
    lockfiles: ["yarn.lock"],
    install: (pkgs) => ["yarn", "add", "--dev", "--exact", ...pkgs],
    runCheckCi: "yarn biome ci --reporter=github .",
    setupSteps: [
      "      - uses: actions/setup-node@v4",
      "        with:",
      `          node-version: ${NODE_VERSION}`,
      "          cache: yarn",
      "      - run: yarn install --frozen-lockfile",
    ],
  },
};

// How each package manager's "run a package binary" command is spelled.
const RUNNERS = { npm: "npx", pnpm: "pnpm dlx", yarn: "yarn dlx", bun: "bunx" };

/** "npm/10.8.0 node/v22.1.0 darwin arm64 ..." -> "npm" (null if unknown). */
export function parseUserAgent(userAgent) {
  const name = String(userAgent ?? "")
    .split(" ")[0]
    ?.split("/")[0];
  return name && name in PACKAGE_MANAGERS ? name : null;
}

/**
 * Which package manager should install things in this project?
 * In order: the `packageManager` field, a lockfile, the tool that launched us
 * (npm_config_user_agent, set by npx / pnpm dlx / yarn dlx / bunx), then npm,
 * which ships with Node.js. Returns { name, source }.
 */
export function detectPackageManager(cwd, pkg, env = process.env) {
  const declared = pkg?.packageManager?.split("@")[0];
  if (declared && declared in PACKAGE_MANAGERS) {
    return { name: declared, source: "the packageManager field in package.json" };
  }
  for (const [name, pm] of Object.entries(PACKAGE_MANAGERS)) {
    const lockfile = pm.lockfiles.find((file) => existsSync(join(cwd, file)));
    if (lockfile) return { name, source: lockfile };
  }
  const fromAgent = parseUserAgent(env.npm_config_user_agent);
  if (fromAgent) return { name: fromAgent, source: "the command that launched lintlane" };
  return { name: "npm", source: "default" };
}

/** The runner prefix to show in messages: "npx", "pnpm dlx", "yarn dlx" or "bunx". */
export function runnerCommand(env = process.env) {
  return RUNNERS[parseUserAgent(env.npm_config_user_agent) ?? "npm"];
}

/** The argv that installs `packages` as exact dev dependencies. */
export function installCommand(pmName, packages) {
  const pm = PACKAGE_MANAGERS[pmName];
  if (!pm) throw new Error(`Unknown package manager "${pmName}"`);
  return pm.install(packages);
}

// Checked in order; the first match wins. Only "next" has its own Biome
// lint domain — the others are still React under the hood, so they map to
// the "base" preset, but we name what we found instead of guessing silently.
const FRAMEWORK_DETECTORS = [
  { label: "Next.js", preset: "next", deps: ["next"] },
  { label: "TanStack Start", preset: "base", deps: ["@tanstack/react-start", "@tanstack/start"] },
  { label: "React Router (framework mode)", preset: "base", deps: ["@react-router/dev"] },
  { label: "Remix", preset: "base", deps: ["@remix-run/react", "@remix-run/node"] },
  { label: "React", preset: "base", deps: ["react"] },
];

export function detectPreset(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const detector of FRAMEWORK_DETECTORS) {
    if (detector.deps.some((dep) => dep in deps)) {
      return { preset: detector.preset, label: detector.label };
    }
  }
  return { preset: "base", label: null };
}

const RUN_SCRIPT_PREFIX = { npm: "npm run", pnpm: "pnpm run", yarn: "yarn run", bun: "bun run" };

/** The `run:` command a check has in the generated workflow, or null if it has none. */
export function ciCommand(pmName, step) {
  if (step.id === "biome") return PACKAGE_MANAGERS[pmName].runCheckCi;
  if (step.ci && step.script) return `${RUN_SCRIPT_PREFIX[pmName]} ${step.script}`;
  return null;
}

/**
 * The GitHub Actions workflow `init` writes. `checks` is the resolved list from
 * checks.mjs, so the workflow runs exactly what the CLI and dashboard run.
 * Without it, only Biome.
 */
export function renderWorkflow({ pmName, kitName, withCommitCheck, checks }) {
  const pm = PACKAGE_MANAGERS[pmName];
  // Catches commits that skipped the local hooks (--no-verify, GUI clients, fresh clones).
  const checkout = withCommitCheck ? "\n        with:\n          fetch-depth: 0" : "";
  const commitStep = withCommitCheck
    ? [
        "",
        "      - name: Check commit messages",
        "        if: github.event_name == 'pull_request'",
        `        run: node node_modules/${kitName}/bin/cli.mjs check-commit --rev-range origin/\${{ github.base_ref }}..HEAD`,
      ].join("\n")
    : "";
  const commands = (checks ?? [{ id: "biome", ci: true }])
    .map((step) => ciCommand(pmName, step))
    .filter(Boolean);
  const runSteps = commands.map((command) => `      - run: ${command}`).join("\n");
  return `name: Biome

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  biome:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4${checkout}
${pm.setupSteps.join("\n")}${commitStep}
${runSteps}
`;
}

/**
 * The pre-commit hook `init` used to write (<= 2.5.1). It re-staged files with
 * `git update-index --again`, which also stages unstaged hunks of partially
 * staged files. `init` replaces an untouched copy of it.
 */
export function isLegacyPreCommit(content) {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.length === 2 &&
    /^(\.\/)?node_modules\/\.bin\/biome check --write --staged\b/.test(lines[0]) &&
    lines[1] === "git update-index --again"
  );
}

/** A pre-commit hook that still has the unsafe re-staging step, but was edited. */
export function hasUnsafeRestaging(content) {
  return /git\s+update-index\s+--again/.test(content);
}

// Hooks written by earlier versions of lintlane that did their own work in
// bin/*.mjs files which no longer exist. An untouched copy is safe to replace.
const LEGACY_HOOKS = {
  "pre-commit": [
    'if [ -f node_modules/lintlane/bin/pre-commit.mjs ]; then\n  node node_modules/lintlane/bin/pre-commit.mjs\nelse\n  echo "lintlane: node_modules/lintlane not found; skipping staged-file checks. Run your package manager\'s install." >&2\nfi',
  ],
  "commit-msg": [
    '[ -f node_modules/lintlane/bin/commit-msg.mjs ] || exit 0\nnode node_modules/lintlane/bin/commit-msg.mjs "$1"',
  ],
  "prepare-commit-msg": [
    '[ -f node_modules/lintlane/bin/prepare-commit-msg.mjs ] || exit 0\nnode node_modules/lintlane/bin/prepare-commit-msg.mjs "$1" "$2"',
  ],
  "pre-push": [
    '[ -f node_modules/lintlane/bin/pre-push-check.mjs ] || exit 0\nnode node_modules/lintlane/bin/pre-push-check.mjs "$1" "$2"',
  ],
};

const REMOVED_ENTRYPOINTS =
  /bin\/(pre-commit|commit-msg|prepare-commit-msg|pre-push-check|staged|commit-lint)\.mjs/;

/**
 * What a hook file is, relative to this version of lintlane:
 *   "current"  the shipped template
 *   "legacy"   an untouched hook from an older lintlane (safe to replace)
 *   "stale"    edited, but still calls files lintlane no longer ships (needs a human)
 *   "unsafe"   edited, and re-stages with `git update-index --again`
 *   "custom"   the project's own hook
 */
export function classifyHook(name, content, template) {
  const normalized = content.trim();
  if (normalized === template.trim()) return "current";
  if (name === "pre-commit" && isLegacyPreCommit(content)) return "legacy";
  if ((LEGACY_HOOKS[name] ?? []).some((legacy) => legacy === normalized)) return "legacy";
  if (REMOVED_ENTRYPOINTS.test(content)) return "stale";
  if (name === "pre-commit" && hasUnsafeRestaging(content)) return "unsafe";
  return "custom";
}

/** Does the project already configure lint-staged? (package.json key or a config file) */
export function hasLintStagedConfig(cwd, pkg) {
  if (pkg?.["lint-staged"]) return true;
  return [
    ".lintstagedrc",
    ".lintstagedrc.json",
    ".lintstagedrc.yaml",
    ".lintstagedrc.yml",
    ".lintstagedrc.js",
    ".lintstagedrc.cjs",
    ".lintstagedrc.mjs",
    "lint-staged.config.js",
    "lint-staged.config.cjs",
    "lint-staged.config.mjs",
  ].some((file) => existsSync(join(cwd, file)));
}

/** Does the project already configure commitlint? */
export function hasCommitlintConfig(cwd, pkg) {
  if (pkg?.commitlint) return true;
  return [
    ".commitlintrc",
    ".commitlintrc.json",
    ".commitlintrc.yaml",
    ".commitlintrc.yml",
    ".commitlintrc.js",
    ".commitlintrc.cjs",
    ".commitlintrc.mjs",
    ".commitlintrc.ts",
    "commitlint.config.js",
    "commitlint.config.cjs",
    "commitlint.config.mjs",
    "commitlint.config.ts",
  ].some((file) => existsSync(join(cwd, file)));
}

export const LINT_STAGED_CONFIG = {
  "*": "biome check --write --no-errors-on-unmatched --files-ignore-unknown=true",
};
export const COMMITIZEN_PATH = "lintlane/presets/commitizen.cjs";
