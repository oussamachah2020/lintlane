import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { binPath, spawnPrepared } from "./proc.mjs";

const MAX_LOG_CHARS = 2_000_000;

const RUN_SCRIPT = {
  bun: (name) => ["bun", "run", name],
  npm: (name) => ["npm", "run", name],
  pnpm: (name) => ["pnpm", "run", name],
  yarn: (name) => ["yarn", "run", name],
};

// Same commands the generated GitHub workflow uses for its install step.
const FROZEN_INSTALL = {
  bun: ["bun", "install", "--frozen-lockfile"],
  npm: ["npm", "ci"],
  pnpm: ["pnpm", "install", "--frozen-lockfile"],
  yarn: ["yarn", "install", "--frozen-lockfile"],
};

const NPM_DEFAULT_TEST = /no test specified/i;
const CHECK_IDS = ["biome", "typecheck", "build", "test", "e2e"];

function firstScript(scripts, names) {
  return names.find((name) => typeof scripts[name] === "string");
}

/**
 * The one list of checks. The dashboard, `lintlane run` and the generated CI
 * workflow all read it, so they can't drift apart.
 *
 * Detected from package.json (scripts, tsconfig) and tuned in package.json:
 *
 *   "lintlane": { "checks": { "build": false, "test": "test:unit", "typecheck": true } }
 *
 * false turns a check off everywhere; a string names the package.json script to
 * run; true keeps the detected one. Unknown ids and bad values are reported in
 * `problems` and otherwise ignored. Only script names ever come from config,
 * never command lines, and the browser only ever sends step ids back.
 *
 * Each step: { id, label, cmd, display, defaultOn, note?, ci, script? }.
 * `ci` says whether the generated workflow runs it; `script` is the
 * package.json script behind it (null for Biome and the raw tsc fallback).
 */
export function resolveChecks({ cwd, biome, pmName, pkg }) {
  const scripts = pkg?.scripts ?? {};
  const run = RUN_SCRIPT[pmName] ?? RUN_SCRIPT.npm;
  const config = pkg?.lintlane?.checks;
  const settings = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const problems = [];

  for (const [id, value] of Object.entries(settings)) {
    if (!CHECK_IDS.includes(id)) {
      problems.push(`lintlane.checks.${id}: unknown check (known: ${CHECK_IDS.join(", ")})`);
    } else if (typeof value !== "boolean" && typeof value !== "string") {
      problems.push(`lintlane.checks.${id}: expected true, false or a script name`);
    } else if (typeof value === "string" && id !== "biome" && typeof scripts[value] !== "string") {
      problems.push(`lintlane.checks.${id}: package.json has no script "${value}"`);
    } else if (typeof value === "string" && id === "biome") {
      problems.push("lintlane.checks.biome: can only be true or false");
    }
  }

  // The script a check should run: the configured one if it exists, else detection.
  const scriptFor = (id, candidates) => {
    const chosen = settings[id];
    if (typeof chosen === "string" && typeof scripts[chosen] === "string" && id !== "biome") {
      return chosen;
    }
    return firstScript(scripts, candidates);
  };
  const enabled = (id) => settings[id] !== false;

  const steps = [];
  steps.push({
    id: "install",
    label: "Install (frozen lockfile)",
    cmd: FROZEN_INSTALL[pmName] ?? FROZEN_INSTALL.npm,
    defaultOn: false,
    ci: false,
    note: "What CI does first. Reinstalls node_modules, so it's off by default.",
  });

  if (enabled("biome")) {
    steps.push({
      id: "biome",
      label: "Biome CI (lint + format)",
      cmd: [...biome, "ci", "--colors=off", "."],
      display: "biome ci .",
      defaultOn: true,
      ci: true,
      note: "The same check the GitHub workflow runs.",
    });
  }

  if (enabled("typecheck")) {
    const script = scriptFor("typecheck", ["typecheck", "type-check", "check-types", "tsc"]);
    if (script) {
      steps.push({
        id: "typecheck",
        label: "Typecheck",
        cmd: run(script),
        script,
        defaultOn: true,
        ci: true,
      });
    } else if (existsSync(`${cwd}/tsconfig.json`) && existsSync(binPath(cwd, "tsc"))) {
      steps.push({
        id: "typecheck",
        label: "Typecheck",
        cmd: [binPath(cwd, "tsc"), "--noEmit"],
        display: "tsc --noEmit",
        defaultOn: true,
        ci: false, // no script to name in a workflow
      });
    }
  }

  if (enabled("build")) {
    const script = scriptFor("build", ["build"]);
    if (script) {
      steps.push({
        id: "build",
        label: "Build",
        cmd: run(script),
        script,
        defaultOn: true,
        ci: true,
      });
    }
  }

  if (enabled("test")) {
    const script = scriptFor("test", ["test"]);
    if (script && !NPM_DEFAULT_TEST.test(scripts[script])) {
      steps.push({
        id: "test",
        label: "Tests",
        cmd: run(script),
        script,
        defaultOn: true,
        ci: true,
      });
    }
  }

  if (enabled("e2e")) {
    const script = scriptFor("e2e", ["test:e2e"]);
    if (script)
      steps.push({
        id: "e2e",
        label: "Browser tests",
        cmd: run(script),
        script,
        defaultOn: true,
        ci: false,
        note: "Browser dependencies must be installed separately.",
      });
  }
  return {
    steps: steps.map((step) => ({ ...step, display: step.display ?? step.cmd.join(" ") })),
    problems,
  };
}

// Kill the step and everything it started (a build tool's child processes too).
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill();
    } catch {}
  }
}

/**
 * Run steps one after another, reporting events through `send`:
 *   start / log / end / skip / done
 * Aborting `signal` (the browser's Stop button, or the page closing) kills the
 * running step. Resolves when the run is over; never rejects.
 */
export async function runCiSteps({ cwd, steps, stopOnFail, send, signal, extraEnv = {} }) {
  let child = null;
  const onAbort = () => killTree(child);
  signal?.addEventListener("abort", onAbort);
  let failed = false;

  try {
    for (const step of steps) {
      if (signal?.aborted) return;
      if (failed && stopOnFail) {
        send({ type: "skip", id: step.id });
        continue;
      }

      send({ type: "start", id: step.id });
      const t0 = performance.now();
      let sent = 0;
      let truncated = false;

      const pump = (stream) => {
        const decoder = new StringDecoder("utf8");
        stream.on("data", (chunk) => {
          const text = decoder.write(chunk);
          if (sent < MAX_LOG_CHARS) {
            sent += text.length;
            send({ type: "log", id: step.id, text });
          } else if (!truncated) {
            truncated = true;
            send({ type: "log", id: step.id, text: "\n… output truncated …\n" });
          }
        });
      };

      const code = await new Promise((resolve) => {
        try {
          child = spawnPrepared(step.cmd[0], step.cmd.slice(1), {
            cwd,
            env: { ...process.env, CI: "true", NO_COLOR: "1", FORCE_COLOR: "0", ...extraEnv },
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32", // own process group, so Stop can kill the tree
          });
        } catch (error) {
          send({ type: "log", id: step.id, text: `\n${error.message}\n` });
          resolve(127);
          return;
        }
        pump(child.stdout);
        pump(child.stderr);
        child.on("error", (error) => {
          send({ type: "log", id: step.id, text: `\n${error.message}\n` });
          resolve(127);
        });
        child.on("close", (exitCode, killedBy) => resolve(exitCode ?? (killedBy ? 143 : 1)));
      });
      child = null;

      if (signal?.aborted) return;
      if (code !== 0) failed = true;
      send({ type: "end", id: step.id, code, ms: Math.round(performance.now() - t0) });
    }
    send({ type: "done" });
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
