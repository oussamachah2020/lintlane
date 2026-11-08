import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveChecks, runCiSteps } from "./checks.mjs";
import { formatReport, runDoctor } from "./doctor.mjs";
import { runProcess, spawnPrepared } from "./proc.mjs";

const MAX_FILES = 200;
const MAX_BODY = 1024 * 1024;

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safePath(cwd, file) {
  if (typeof file !== "string" || file.includes("\0")) return null;
  const abs = resolve(cwd, file);
  return isInside(cwd, abs) && abs !== cwd ? abs : null;
}

function tokenMatches(given, expected) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Only answer requests addressed to the loopback name we listen on. A hostile web
// page can point its own domain at 127.0.0.1 (DNS rebinding); its Host header then
// names that domain, not us.
function hostAllowed(hostHeader, port) {
  if (typeof hostHeader !== "string") return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(hostHeader.toLowerCase());
}

const runBiome = (biome, args, options) =>
  runProcess(biome[0], [...biome.slice(1), ...args], options);

async function runCheck(cwd, biome) {
  const t0 = performance.now();
  console.log("… running biome check");
  const result = await runBiome(biome, ["check", "--reporter=json", "."], { cwd });
  const out = result.stdout.toString().trim();
  console.log(
    `… biome finished in ${((performance.now() - t0) / 1000).toFixed(1)}s (${(out.length / 1024).toFixed(0)} KB of output)`,
  );
  const start = out.indexOf("{");
  if (start === -1) {
    const detail = result.error
      ? `Couldn't start Biome: ${result.error.message}`
      : result.stderr.toString().trim() ||
        `Biome exited with code ${result.code} and no JSON output`;
    throw new Error(detail);
  }
  let report;
  try {
    report = JSON.parse(out.slice(start));
  } catch {
    throw new Error(
      `Biome's output wasn't valid JSON (exit code ${result.code}). Run \`biome check .\` in a terminal to see the problem.`,
    );
  }

  const byFile = new Map();
  for (const d of report.diagnostics ?? []) {
    const path = d.location?.path;
    if (!path) continue;
    if (!byFile.has(path)) byFile.set(path, []);
    byFile.get(path).push({
      severity: d.severity,
      message: d.message,
      category: d.category,
      start: d.location.start,
      end: d.location.end,
    });
  }

  const files = [...byFile].slice(0, MAX_FILES).map(([path, diagnostics]) => ({
    path,
    diagnostics,
  }));

  const s = report.summary ?? {};
  return {
    summary: { errors: s.errors ?? 0, warnings: s.warnings ?? 0, infos: s.infos ?? 0 },
    files,
    totalFiles: byFile.size,
    truncated: byFile.size > MAX_FILES,
    exitCode: result.code,
    ms: Math.round(performance.now() - t0),
  };
}

// Computed on demand (when the user opens a file) so a check on a big project
// doesn't have to spawn Biome once per file up front.
async function getDiff(cwd, biome, file) {
  const abs = safePath(cwd, file);
  if (!abs || !existsSync(abs)) throw new Error(`Invalid file: ${file}`);
  const original = await readFile(abs, "utf8");
  const res = await runBiome(biome, ["check", "--write", `--stdin-file-path=${file}`], {
    cwd,
    input: original,
  });
  const text = res.stdout.toString();
  const fixed = text.length > 0 ? text : null;
  return { original, fixed, fixable: fixed !== null && fixed !== original };
}

async function applyFixes(cwd, biome, files) {
  const paths = files.map((file) => {
    const abs = safePath(cwd, file);
    if (!abs || !existsSync(abs)) throw new Error(`Invalid file: ${file}`);
    return file.startsWith("-") ? `./${file}` : file;
  });
  const CHUNK = 100;
  for (let i = 0; i < paths.length; i += CHUNK) {
    await runBiome(biome, ["check", "--write", ...paths.slice(i, i + CHUNK)], { cwd });
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function openBrowser(address) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [address]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", '""', address]]
        : ["xdg-open", [address]];
  try {
    const child = spawnPrepared(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

export async function startUi({ cwd, biome, kitDir, port, open, pmName, pkg }) {
  let ciBusy = false;
  let checkBusy = false;
  const token = randomUUID();
  const checksFor = () => resolveChecks({ cwd, biome, pmName, pkg });
  const html = await readFile(join(kitDir, "ui", "index.html"), "utf8");

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (!hostAllowed(req.headers.host, server.address().port)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden: unexpected Host header.");
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      if (!tokenMatches(url.searchParams.get("t"), token)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("Forbidden: open the URL printed by `lintlane ui`.");
        return;
      }
      const nonce = randomBytes(16).toString("base64");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cross-origin-resource-policy": "same-origin",
        "content-security-policy": [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          "style-src 'unsafe-inline'",
          "connect-src 'self'",
          "img-src 'self' data:",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      });
      res.end(html.replace("__TOKEN__", token).replaceAll("<script", `<script nonce="${nonce}"`));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (!tokenMatches(req.headers["x-lintlane-token"], token)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/check") {
        if (checkBusy) {
          sendJson(res, 409, { error: "A check is already running" });
          return;
        }
        checkBusy = true;
        try {
          sendJson(res, 200, await runCheck(cwd, biome));
        } finally {
          checkBusy = false;
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/fix") {
        const { files } = await readJson(req);
        if (!Array.isArray(files) || files.length === 0) {
          sendJson(res, 400, { error: "No files given" });
          return;
        }
        await applyFixes(cwd, biome, files);
        sendJson(res, 200, { fixed: files.length });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/ci/steps") {
        const { steps, problems } = checksFor();
        sendJson(res, 200, {
          pmName,
          problems,
          busy: ciBusy,
          steps: steps.map(({ id, label, display, defaultOn, note }) => ({
            id,
            label,
            display,
            defaultOn,
            note,
          })),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/ci/run") {
        if (ciBusy) {
          sendJson(res, 409, { error: "A CI run is already in progress" });
          return;
        }
        const { steps: ids, stopOnFail } = await readJson(req);
        const known = checksFor().steps;
        const steps = Array.isArray(ids) ? known.filter((step) => ids.includes(step.id)) : [];
        if (steps.length === 0) {
          sendJson(res, 400, { error: "No steps selected" });
          return;
        }
        ciBusy = true;
        const controller = new AbortController();
        // The browser's Stop button (or closing the tab) ends the response early.
        res.on("close", () => {
          if (!res.writableFinished) controller.abort();
        });
        res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
        try {
          await runCiSteps({
            cwd,
            steps,
            stopOnFail: stopOnFail !== false,
            signal: controller.signal,
            send: (event) => {
              if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`);
            },
          });
        } finally {
          ciBusy = false;
          if (!res.destroyed) res.end();
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/doctor") {
        const report = await runDoctor({ cwd, kitDir });
        sendJson(res, 200, { ...report, text: formatReport(report) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/diff") {
        const { file } = await readJson(req);
        sendJson(res, 200, await getDiff(cwd, biome, file));
        return;
      }
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(res, error instanceof HttpError ? error.status : 500, { error: error.message });
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", (error) => {
      rejectListen(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${port} is already in use. Pick another with --port <n>.`)
          : error,
      );
    });
    server.listen(port, "127.0.0.1", resolveListen);
  });

  const address = `http://127.0.0.1:${server.address().port}/?t=${token}`;
  console.log(`✔ Lintlane dashboard running at ${address}`);
  console.log("  Press Ctrl+C to stop.");

  if (open) openBrowser(address);
  return server;
}
