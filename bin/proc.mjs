// Small process helpers built on node:child_process, so the CLI runs on plain
// Node.js (no Bun APIs). Nothing here goes through a shell on POSIX; arguments
// are always passed as an array.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const isWindows = process.platform === "win32";

/** Path of a binary in the project's node_modules/.bin (a .cmd shim on Windows). */
export function binPath(cwd, name) {
  return join(cwd, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);
}

/**
 * The command (as an argv prefix) that runs this project's Biome, or null.
 * Prefers the project's own node_modules/.bin/biome; falls back to the Biome
 * that resolves from lintlane itself (its peer dependency).
 */
export function resolveBiome(cwd) {
  const local = binPath(cwd, "biome");
  if (existsSync(local)) return [local];
  try {
    const script = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
    return [process.execPath, script];
  } catch {
    return null;
  }
}

/**
 * The argv that runs a binary shipped by one of lintlane's own dependencies
 * (lint-staged, commitlint, commitizen). Resolved from lintlane's location, so it
 * works with every package manager, including pnpm's strict node_modules layout.
 * Returns null if the package isn't installed.
 */
export function resolveTool(pkgName, binName = pkgName) {
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve(`${pkgName}/package.json`);
    const manifest = require(manifestPath);
    const rel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
    if (!rel) return null;
    return [process.execPath, join(dirname(manifestPath), rel)];
  } catch {
    return null;
  }
}

/** Run Commitizen through the bundled-adapter compatibility entry point. */
export function resolveCommitizen() {
  if (!resolveTool("commitizen", "git-cz")) return null;
  return [process.execPath, fileURLToPath(new URL("./commitizen.cjs", import.meta.url))];
}

// Windows can't spawn .cmd shims (npm, pnpm, yarn, node_modules/.bin/*) without
// a shell. git and node are real executables and are spawned directly.
function prepare(command, args) {
  const direct = !isWindows || /(^|[\\/])(git|node)(\.exe)?$/i.test(command);
  if (direct) return { command, args, options: {} };
  const quote = (arg) => (/[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);
  return {
    command: [command, ...args].map(quote).join(" "),
    args: [],
    options: { shell: true },
  };
}

/**
 * Run a command and collect its output. Never rejects: a command that can't be
 * started resolves with `error` set and code 127.
 */
export function runProcess(command, args = [], { cwd, input, env } = {}) {
  return new Promise((resolve) => {
    const prepared = prepare(command, args);
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), ...result });
    };

    let child;
    try {
      child = spawn(prepared.command, prepared.args, {
        cwd,
        env: env ?? process.env,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        ...prepared.options,
      });
    } catch (error) {
      finish({ code: 127, error });
      return;
    }
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => finish({ code: 127, error }));
    child.on("close", (code, signal) => finish({ code: code ?? (signal ? 128 : 1), signal }));
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

/** Run a command with the terminal attached. Resolves with its exit code. */
export function runInherit(command, args = [], { cwd, env } = {}) {
  return new Promise((resolve) => {
    const prepared = prepare(command, args);
    let child;
    try {
      child = spawn(prepared.command, prepared.args, {
        cwd,
        env: env ?? process.env,
        stdio: "inherit",
        ...prepared.options,
      });
    } catch (error) {
      process.stderr.write(`✘ ${error.message}\n`);
      resolve(127);
      return;
    }
    child.on("error", (error) => {
      process.stderr.write(`✘ ${error.message}\n`);
      resolve(127);
    });
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

/** Spawn for streaming callers (the CI tab); same Windows handling as above. */
export function spawnPrepared(command, args, options) {
  const prepared = prepare(command, args);
  return spawn(prepared.command, prepared.args, { ...options, ...prepared.options });
}
