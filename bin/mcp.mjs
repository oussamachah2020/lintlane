#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveChecks } from "./checks.mjs";
import { resolveBiome } from "./proc.mjs";
import { detectPackageManager } from "./project.mjs";

const kitDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(kitDir, "package.json"), "utf8"));
const cli = join(kitDir, "bin", "cli.mjs");
const MAX_OUTPUT = 256 * 1024;
const TIMEOUT = 120_000;

export async function createLintlaneServer({ project, allowWrite = false }) {
  const cwd = await realpath(project);
  await readFile(join(cwd, "package.json"), "utf8");
  const server = new McpServer({ name: "lintlane", version: manifest.version });
  let busy = false;
  const children = new Set();
  const stop = (child) => {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {}
  };
  server.server.onclose = () => {
    for (const child of children) stop(child);
  };

  async function execute(args) {
    return new Promise((done) => {
      const child = spawn(process.execPath, [cli, ...args], {
        cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CI: "true",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          LINTLANE_NO_PROMPT: "1",
        },
      });
      children.add(child);
      let stdout = "",
        stderr = "",
        size = 0,
        truncated = false,
        timedOut = false;
      const collect = (stream) => (chunk) => {
        const remaining = MAX_OUTPUT - size;
        const part = chunk.subarray(0, Math.max(0, remaining));
        size += part.length;
        if (stream === "stdout") stdout += part.toString();
        else stderr += part.toString();
        if (part.length < chunk.length) truncated = true;
      };
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));
      const timer = setTimeout(() => {
        timedOut = true;
        stop(child);
      }, TIMEOUT);
      child.on("error", (error) => {
        stderr += error.message;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        children.delete(child);
        done({ exitCode: code ?? 1, stdout, stderr, truncated, timedOut });
      });
    });
  }

  async function pathsWithinProject(paths) {
    return Promise.all(
      paths.map(async (path) => {
        const target = await realpath(resolve(cwd, path));
        const rel = relative(cwd, target);
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
          throw new Error("Paths must stay inside the configured project, including symlinks.");
        if (rel.split(sep).some((part) => [".git", "node_modules"].includes(part)))
          throw new Error("Do not target .git or node_modules.");
        return rel ? `.${sep}${rel}` : ".";
      }),
    );
  }

  function tool(name, description, shape, handler, readOnly = false) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: shape,
        annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false },
      },
      async (args) => {
        if (busy)
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Another Lintlane operation is running. Retry after it finishes.",
              },
            ],
          };
        busy = true;
        try {
          const result = await handler(args);
          return {
            isError: result.exitCode !== undefined && result.exitCode !== 0,
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error.message }] };
        } finally {
          busy = false;
        }
      },
    );
  }
  const paths = z.array(z.string().min(1)).min(1).max(100).default(["."]);
  tool(
    "lintlane_doctor",
    "Diagnose the configured project's tools, hooks, configuration, and CI without changing files.",
    {},
    async () => {
      const result = await execute(["doctor", "--json"]);
      if (!result.truncated && !result.timedOut) {
        try {
          return { ...result, report: JSON.parse(result.stdout), project: cwd, allowWrite };
        } catch {}
      }
      return result;
    },
    true,
  );
  tool(
    "lintlane_checks",
    "List available project checks and configuration problems. Does not execute scripts.",
    {},
    async () => {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
      const biome = resolveBiome(cwd);
      if (!biome) throw new Error("Biome is not installed. Set up Lintlane in the project first.");
      const { steps, problems } = resolveChecks({
        cwd,
        biome,
        pmName: detectPackageManager(cwd, pkg).name,
        pkg,
      });
      return {
        project: cwd,
        allowWrite,
        problems,
        steps: steps.map(({ id, label, display, defaultOn }) => ({
          id,
          label,
          display,
          defaultOn,
        })),
      };
    },
    true,
  );
  tool(
    "lintlane_check",
    "Run Biome lint and formatting diagnostics on project paths. Does not apply fixes.",
    { paths },
    async ({ paths }) => execute(["check", ...(await pathsWithinProject(paths))]),
    true,
  );
  tool(
    "lintlane_fix",
    "Apply Biome's supported fixes to explicit project paths. Requires server --allow-write; inspect the resulting diff and recheck.",
    { paths: z.array(z.string().min(1)).min(1).max(100) },
    async ({ paths }) => {
      if (!allowWrite)
        throw new Error(
          "Fixes are disabled. Restart the server with --allow-write to enable them.",
        );
      return execute(["check:fix", ...(await pathsWithinProject(paths))]);
    },
  );
  tool(
    "lintlane_run",
    "Run configured project checks in pipeline order. Build/test/typecheck execute project scripts and may write artifacts. Installation is excluded; discover checks first.",
    {
      checks: z
        .array(z.enum(["biome", "typecheck", "build", "test"]))
        .min(1)
        .max(4),
      keepGoing: z.boolean().default(false),
    },
    async ({ checks, keepGoing }) =>
      execute(["run", ...checks, ...(keepGoing ? ["--keep-going"] : [])]),
  );
  tool(
    "lintlane_check_commit",
    "Validate a Conventional Commit message with commitlint. Does not create a commit or invoke the interactive Commitizen prompt.",
    { message: z.string().min(1).max(20000) },
    async ({ message }) => execute(["check-commit", "--message", message]),
    true,
  );
  tool(
    "lintlane_preview_setup",
    "Preview Lintlane initialization without writing configuration or installing dependencies.",
    {},
    async () => execute(["init", "--dry-run"]),
    true,
  );
  return server;
}

if (process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        project: { type: "string" },
        "allow-write": { type: "boolean", default: false },
        help: { type: "boolean" },
      },
    });
    if (values.help)
      process.stdout.write(
        "Usage: lintlane-mcp --project <directory> [--allow-write]\nStdio MCP server; fixes are disabled by default. Project checks execute project scripts.\n",
      );
    else {
      if (!values.project) throw new Error("Pass --project <directory> to select the project.");
      const server = await createLintlaneServer({
        project: values.project,
        allowWrite: values["allow-write"],
      });
      await server.connect(new StdioServerTransport());
      for (const signal of ["SIGINT", "SIGTERM"]) {
        process.once(signal, () => {
          server.close().finally(() => process.exit(0));
        });
      }
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
