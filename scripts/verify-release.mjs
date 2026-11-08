#!/usr/bin/env node
// Release verification: pack the package, install the tarball into a fresh
// project with a real package manager, run `init`, then `doctor`, `run` and a
// real commit through the hooks. Nothing is published.
//
//   node scripts/verify-release.mjs [npm|pnpm|yarn|bun]     (default: npm)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pm = process.argv[2] ?? "npm";
const work = mkdtempSync(join(tmpdir(), "lintlane-release-"));
const env = { ...process.env, GIT_CONFIG_GLOBAL: join(work, "gitconfig") };
for (const key of Object.keys(env))
  if (key.startsWith("GIT_") && key !== "GIT_CONFIG_GLOBAL") delete env[key];
writeFileSync(
  join(work, "gitconfig"),
  "[user]\n\tname = Release\n\temail = release@example.com\n[commit]\n\tgpgsign = false\n",
);

let failed = false;
function step(title, command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env, ...options });
  const good = result.status === 0;
  console.log(`${good ? "✔" : "✘"} ${title}`);
  if (!good) {
    failed = true;
    console.log((result.stdout ?? "") + (result.stderr ?? ""));
    throw new Error(`${title} failed`);
  }
  return result;
}

try {
  const pack = step("npm pack", "npm", ["pack", "--pack-destination", work, "--json"], {
    cwd: KIT,
  });
  const tarball = join(work, JSON.parse(pack.stdout)[0].filename);
  const app = join(work, "app");
  mkdirSync(app);
  writeFileSync(
    join(app, "package.json"),
    `${JSON.stringify({ name: "release-check", version: "1.0.0", private: true, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  writeFileSync(join(app, ".gitignore"), "node_modules\n");
  step("git init", "git", ["init", "-q", "-b", "main"], { cwd: app });

  const cli = ["node", join(app, "node_modules", "lintlane", "bin", "cli.mjs")];
  const installEnv = {
    ...env,
    LINTLANE_INSTALL_SPEC: tarball,
    npm_config_user_agent: `${pm}/1.0.0`,
  };
  // Bootstrap with the tarball's own CLI, exactly what `npx lintlane init` runs.
  step("unpack tarball", "tar", ["-xzf", tarball, "-C", work]);
  step(`init (${pm}, real install)`, "node", [join(work, "package", "bin", "cli.mjs"), "init"], {
    cwd: app,
    env: installEnv,
  });
  step("doctor reports nothing broken", cli[0], [...cli.slice(1), "doctor"], { cwd: app });
  writeFileSync(join(app, "a.js"), "export const a   =   1\n");
  step("git add", "git", ["add", "-A"], { cwd: app });
  step("hooks reject a bad message", "sh", ["-c", "! git commit -q -m 'bad message' 2>/dev/null"], {
    cwd: app,
  });
  step("hooks accept a Conventional Commit", "git", ["commit", "-q", "-m", "feat: add a"], {
    cwd: app,
  });
  const committed = spawnSync("git", ["show", "HEAD:a.js"], {
    cwd: app,
    encoding: "utf8",
    env,
  }).stdout;
  if (committed !== "export const a = 1;\n")
    throw new Error(`staged file wasn't formatted: ${JSON.stringify(committed)}`);
  console.log("✔ staged file was formatted by the pre-commit hook");
  step("lintlane run", cli[0], [...cli.slice(1), "run"], { cwd: app });
  console.log(`\nRelease verification passed with ${pm}.`);
} catch (error) {
  console.error(`\n${error.message}`);
  failed = true;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
