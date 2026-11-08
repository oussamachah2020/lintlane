// Unit tests for package-manager detection and command generation. These are
// pure functions: no package manager is run (see cli.test.mjs for mocked
// installs and e2e.test.mjs for real ones).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  detectPackageManager,
  detectPreset,
  hasUnsafeRestaging,
  installCommand,
  isLegacyPreCommit,
  PACKAGE_MANAGERS,
  parseUserAgent,
  renderWorkflow,
  runnerCommand,
} from "../bin/project.mjs";
import { tempDir } from "./helpers.mjs";

const NO_AGENT = {};

function projectWith(...files) {
  const dir = tempDir();
  for (const file of files) writeFileSync(join(dir, file), "");
  return dir;
}

describe("detectPackageManager", () => {
  it("prefers the packageManager field over everything else", () => {
    const dir = projectWith("package-lock.json");
    const result = detectPackageManager(
      dir,
      { packageManager: "pnpm@9.1.0" },
      { npm_config_user_agent: "yarn/4.0.0" },
    );
    assert.equal(result.name, "pnpm");
    assert.match(result.source, /packageManager/);
  });

  it("ignores an unknown packageManager value", () => {
    const dir = projectWith("yarn.lock");
    assert.equal(
      detectPackageManager(dir, { packageManager: "deno@1.0.0" }, NO_AGENT).name,
      "yarn",
    );
  });

  for (const [name, lockfile] of [
    ["bun", "bun.lock"],
    ["bun", "bun.lockb"],
    ["npm", "package-lock.json"],
    ["npm", "npm-shrinkwrap.json"],
    ["pnpm", "pnpm-lock.yaml"],
    ["yarn", "yarn.lock"],
  ]) {
    it(`detects ${name} from ${lockfile}`, () => {
      const result = detectPackageManager(projectWith(lockfile), {}, NO_AGENT);
      assert.deepEqual(result, { name, source: lockfile });
    });
  }

  it("prefers a lockfile over the tool that launched lintlane", () => {
    const dir = projectWith("package-lock.json");
    assert.equal(
      detectPackageManager(dir, {}, { npm_config_user_agent: "pnpm/9.0.0 npm/? node/v22" }).name,
      "npm",
    );
  });

  for (const [agent, expected] of [
    ["npm/10.8.0 node/v22.1.0 darwin arm64 workspaces/false", "npm"],
    ["pnpm/9.1.0 npm/? node/v22.1.0 darwin arm64", "pnpm"],
    ["yarn/4.2.0 npm/? node/v22.1.0 linux x64", "yarn"],
    ["bun/1.1.8 npm/? node/v22.6.0 linux x64", "bun"],
  ]) {
    it(`uses the launching tool when there is no other signal (${expected})`, () => {
      const result = detectPackageManager(tempDir(), {}, { npm_config_user_agent: agent });
      assert.equal(result.name, expected);
    });
  }

  it("falls back to npm (which ships with Node.js), never to Bun", () => {
    assert.deepEqual(detectPackageManager(tempDir(), {}, NO_AGENT), {
      name: "npm",
      source: "default",
    });
    assert.equal(
      detectPackageManager(tempDir(), {}, { npm_config_user_agent: "something-else/1.0" }).name,
      "npm",
    );
  });

  it("parses user agents defensively", () => {
    assert.equal(parseUserAgent(undefined), null);
    assert.equal(parseUserAgent(""), null);
    assert.equal(parseUserAgent("nonsense"), null);
    assert.equal(parseUserAgent("pnpm/9.0.0"), "pnpm");
  });
});

describe("installCommand", () => {
  const packages = ["@biomejs/biome", "lintlane@2.6.0", "husky"];
  const expected = {
    bun: ["bun", "add", "--dev", "--exact", ...packages],
    npm: ["npm", "install", "--save-dev", "--save-exact", ...packages],
    pnpm: ["pnpm", "add", "--save-dev", "--save-exact", ...packages],
    yarn: ["yarn", "add", "--dev", "--exact", ...packages],
  };

  for (const name of Object.keys(PACKAGE_MANAGERS)) {
    it(`builds the ${name} install command (exact dev dependencies)`, () => {
      assert.deepEqual(installCommand(name, packages), expected[name]);
    });
  }

  it("rejects an unknown package manager", () => {
    assert.throws(() => installCommand("deno", packages), /Unknown package manager/);
  });
});

describe("runnerCommand", () => {
  for (const [agent, runner] of [
    ["npm/10.0.0 node/v22", "npx"],
    ["pnpm/9.0.0 node/v22", "pnpm dlx"],
    ["yarn/4.0.0 node/v22", "yarn dlx"],
    ["bun/1.1.0 node/v22", "bunx"],
  ]) {
    it(`names "${runner}" for ${runner.split(" ")[0]} users`, () => {
      assert.equal(runnerCommand({ npm_config_user_agent: agent }), runner);
    });
  }
  it("defaults to npx", () => assert.equal(runnerCommand({}), "npx"));
});

describe("detectPreset", () => {
  it("uses the next preset only for Next.js", () => {
    assert.deepEqual(detectPreset({ dependencies: { next: "15", react: "19" } }), {
      preset: "next",
      label: "Next.js",
    });
    assert.equal(detectPreset({ devDependencies: { "@remix-run/react": "2" } }).preset, "base");
    assert.equal(detectPreset({ dependencies: { react: "19" } }).label, "React");
    assert.deepEqual(detectPreset({}), { preset: "base", label: null });
  });
});

describe("renderWorkflow", () => {
  const setup = {
    npm: [
      "actions/setup-node@v4",
      "node-version: 22",
      "cache: npm",
      "run: npm ci",
      "run: npx biome ci --reporter=github .",
    ],
    pnpm: [
      "pnpm/action-setup@v4",
      "node-version: 22",
      "cache: pnpm",
      "run: pnpm install --frozen-lockfile",
      "run: pnpm exec biome ci",
    ],
    yarn: [
      "actions/setup-node@v4",
      "node-version: 22",
      "cache: yarn",
      "run: yarn install --frozen-lockfile",
      "run: yarn biome ci",
    ],
    bun: ["oven-sh/setup-bun@v2", "run: bun install --frozen-lockfile", "run: bunx biome ci"],
  };
  for (const [pmName, lines] of Object.entries(setup)) {
    it(`generates the ${pmName} workflow`, () => {
      const yaml = renderWorkflow({ pmName, kitName: "lintlane", withCommitCheck: true });
      for (const line of lines) assert.ok(yaml.includes(line), `${pmName}: missing "${line}"`);
      assert.match(yaml, /^name: Biome$/m);
      assert.match(yaml, /fetch-depth: 0/);
      assert.match(
        yaml,
        /node node_modules\/lintlane\/bin\/cli\.mjs check-commit --rev-range origin\/\$\{\{ github\.base_ref \}\}\.\.HEAD/,
      );
    });
  }

  it("leaves out the commit-message check and the full checkout when asked", () => {
    const yaml = renderWorkflow({ pmName: "npm", kitName: "lintlane", withCommitCheck: false });
    assert.doesNotMatch(yaml, /fetch-depth/);
    assert.doesNotMatch(yaml, /check-commit/);
  });

  it("never needs Bun except for Bun projects", () => {
    for (const pmName of ["npm", "pnpm", "yarn"]) {
      assert.doesNotMatch(
        renderWorkflow({ pmName, kitName: "lintlane", withCommitCheck: true }),
        /\bbunx?\b|setup-bun|oven-sh/i, // not "ubuntu-latest"
      );
    }
  });
});

describe("legacy pre-commit detection", () => {
  const legacy =
    "./node_modules/.bin/biome check --write --staged --no-errors-on-unmatched --files-ignore-unknown=true\ngit update-index --again\n";

  it("recognizes the exact hook older versions wrote", () => {
    assert.equal(isLegacyPreCommit(legacy), true);
    assert.equal(isLegacyPreCommit(`\n${legacy}\n\n`), true);
  });

  it("does not claim a customized hook", () => {
    assert.equal(isLegacyPreCommit(`npm test\n${legacy}`), false);
    assert.equal(isLegacyPreCommit("./node_modules/.bin/biome check --write --staged\n"), false);
    assert.equal(isLegacyPreCommit("node node_modules/lintlane/bin/pre-commit.mjs\n"), false);
  });

  it("flags any hook that still re-stages with update-index --again", () => {
    assert.equal(hasUnsafeRestaging(`npm test\n${legacy}`), true);
    assert.equal(hasUnsafeRestaging("git  update-index   --again"), true);
    assert.equal(hasUnsafeRestaging("node node_modules/lintlane/bin/pre-commit.mjs"), false);
  });
});
