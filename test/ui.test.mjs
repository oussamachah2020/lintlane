// Integration tests for `lintlane ui`: the real CLI is started as a child
// process on Node.js and the dashboard is driven over HTTP.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CLI, cleanEnv, gitOut, read, startAndWait, tempDir, write } from "./helpers.mjs";

const SPACES = '{ "formatter": { "indentStyle": "space", "indentWidth": 2 } }\n';

function makeProject() {
  const dir = tempDir();
  write(
    dir,
    "package.json",
    `${JSON.stringify(
      {
        name: "app",
        scripts: {
          build: "node -e \"console.log('built ok')\"",
          test: "node -e \"require('fs').writeFileSync('child.pid', String(process.pid)); setTimeout(() => {}, 60000)\"",
          typecheck: 'node -e "process.exit(3)"',
        },
      },
      null,
      2,
    )}\n`,
  );
  write(dir, "biome.json", SPACES);
  write(dir, "a.js", "export const a   =   1\n");
  write(dir, "b.js", "export const b = 2;\n");
  gitOut(dir, "init", "-q", "-b", "main");
  return dir;
}

async function startDashboard(dir, extraArgs = []) {
  const started = await startAndWait(
    "node",
    [CLI, "ui", "--no-open", "--port", "0", ...extraArgs],
    {
      cwd: dir,
      pattern: /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f-]+)/,
    },
  );
  const [, port, token] = started.match;
  const base = `http://127.0.0.1:${port}`;
  const api = async (path, body, init = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lintlane-token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
    return { status: res.status, json: async () => res.json(), res };
  };
  return { base, token, api, child: started.child, output: started.output };
}

/** Read an NDJSON response to the end, returning the events. */
async function readEvents(res) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line) events.push(JSON.parse(line));
    }
  }
  return events;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitUntil = async (condition, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
};

describe("lintlane ui (Node.js)", () => {
  let dir;
  let ui;

  before(async () => {
    dir = makeProject();
    ui = await startDashboard(dir);
  });
  after(() => ui?.child.kill("SIGKILL"));

  it("starts, prints a tokenized loopback URL, and binds to 127.0.0.1 only", async () => {
    assert.match(ui.output(), /Lintlane dashboard running at http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    await waitUntil(() => /Press Ctrl\+C to stop/.test(ui.output()), 5000);
  });

  it("serves the page only with the token, and embeds the token in it", async () => {
    const denied = await fetch(`${ui.base}/`);
    assert.equal(denied.status, 403);
    const wrong = await fetch(`${ui.base}/?t=nope`);
    assert.equal(wrong.status, 403);

    const page = await fetch(`${ui.base}/?t=${ui.token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    const html = await page.text();
    assert.match(html, /<title>Lintlane<\/title>/);
    assert.ok(html.includes(ui.token), "the page carries the token for its API calls");
    assert.ok(!html.includes("__TOKEN__"), "the placeholder is replaced");
  });

  it("rejects API calls without the right token", async () => {
    const none = await fetch(`${ui.base}/api/check`, { method: "POST" });
    assert.equal(none.status, 401);
    const wrong = await fetch(`${ui.base}/api/check`, {
      method: "POST",
      headers: { "x-lintlane-token": "nope" },
    });
    assert.equal(wrong.status, 401);
    assert.equal((await fetch(`${ui.base}/nothing-here`)).status, 404);
  });

  it("sends a CSP with a per-page nonce on every script, plus hardening headers", async () => {
    const page = await fetch(`${ui.base}/?t=${ui.token}`);
    const csp = page.headers.get("content-security-policy");
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce, csp);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'none'/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    const html = await page.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    assert.ok(scripts.length > 0);
    for (const tag of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
    const again = await fetch(`${ui.base}/?t=${ui.token}`);
    assert.notEqual(
      /script-src 'nonce-([^']+)'/.exec(again.headers.get("content-security-policy"))[1],
      nonce,
    );
  });

  it("refuses requests whose Host header isn't loopback (DNS rebinding)", async () => {
    const { port } = new URL(ui.base);
    const status = await new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: `/?t=${ui.token}`, headers: { host: "evil.example.com" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  it("reports the setup through /api/doctor, using the same checks as the CLI", async () => {
    const res = await ui.api("/api/doctor");
    assert.equal(res.status, 200);
    const report = await res.json();
    assert.equal(typeof report.ok, "boolean");
    assert.ok(report.findings.some((f) => f.id === "biome"));
    assert.match(report.text, /lintlane doctor/);
  });

  it("rejects malformed JSON", async () => {
    const res = await fetch(`${ui.base}/api/fix`, {
      method: "POST",
      headers: { "x-lintlane-token": ui.token },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });

  it("/api/check reports Biome's findings (using the Biome that ships with lintlane)", async () => {
    const res = await ui.api("/api/check");
    assert.equal(res.status, 200);
    const result = await res.json();
    assert.ok(result.summary.errors >= 1);
    assert.deepEqual(
      result.files.map((f) => f.path),
      ["a.js"],
    );
    assert.ok(result.files[0].diagnostics.some((d) => d.category === "format"));
  });

  it("/api/diff returns the proposed fix and refuses paths outside the project", async () => {
    const diff = await (await ui.api("/api/diff", { file: "a.js" })).json();
    assert.equal(diff.original, "export const a   =   1\n");
    assert.equal(diff.fixed, "export const a = 1;\n");
    assert.equal(diff.fixable, true);

    for (const file of ["../outside.js", "/etc/passwd", "a.js\0.txt", 5]) {
      const res = await ui.api("/api/diff", { file });
      assert.equal(res.status, 500, `${String(file)} must be refused`);
      assert.match((await res.json()).error, /Invalid file/);
    }
  });

  it("/api/ci/steps lists the steps detected from package.json", async () => {
    const { pmName, steps } = await (await ui.api("/api/ci/steps")).json();
    assert.equal(pmName, "npm");
    assert.deepEqual(
      steps.map((s) => s.id),
      ["install", "biome", "typecheck", "build", "test"],
    );
    assert.equal(steps.find((s) => s.id === "install").defaultOn, false);
    assert.equal(steps.find((s) => s.id === "build").display, "npm run build");
    for (const step of steps)
      assert.equal(step.cmd, undefined, "command lines are never sent to the browser");
  });

  it("/api/ci/run streams events and rejects unknown steps", async () => {
    const res = await ui.api("/api/ci/run", { steps: ["build"], stopOnFail: true });
    assert.equal(res.status, 200);
    assert.match(res.res.headers.get("content-type"), /x-ndjson/);
    const events = await readEvents(res.res);
    assert.deepEqual(
      events.map((e) => e.type).filter((t) => t !== "log"),
      ["start", "end", "done"],
    );
    assert.ok(
      events
        .filter((e) => e.type === "log")
        .map((e) => e.text)
        .join("")
        .includes("built ok"),
    );
    assert.equal(events.find((e) => e.type === "end").code, 0);

    const bad = await ui.api("/api/ci/run", { steps: ["rm -rf /"] });
    assert.equal(bad.status, 400);
  });

  it("stop-on-failure skips the remaining steps; without it they all run", async () => {
    const stop = await readEvents(
      (await ui.api("/api/ci/run", { steps: ["typecheck", "build"], stopOnFail: true })).res,
    );
    assert.deepEqual(
      stop.filter((e) => e.type !== "log").map((e) => `${e.type}:${e.id ?? ""}:${e.code ?? ""}`),
      ["start:typecheck:", "end:typecheck:3", "skip:build:", "done::"],
    );
    const all = await readEvents(
      (await ui.api("/api/ci/run", { steps: ["typecheck", "build"], stopOnFail: false })).res,
    );
    assert.deepEqual(
      all.filter((e) => e.type === "end").map((e) => `${e.id}:${e.code}`),
      ["typecheck:3", "build:0"],
    );
  });

  it("Stop kills the running step and everything it started, and frees the dashboard for the next run", async () => {
    const controller = new AbortController();
    const res = await ui.api("/api/ci/run", { steps: ["test"] }, { signal: controller.signal });
    // Read until the step has started, but keep the connection open (don't cancel the stream).
    const reader = res.res.body.getReader();
    let seen = "";
    while (!seen.includes('"type":"start"')) {
      const { value, done } = await reader.read();
      assert.equal(done, false, "the stream ended before the step started");
      seen += new TextDecoder().decode(value);
    }

    const pidFile = join(dir, "child.pid");
    await waitUntil(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(alive(pid), "the step is running");

    // A second run while one is active is refused.
    assert.equal((await ui.api("/api/ci/run", { steps: ["build"] })).status, 409);

    controller.abort();
    await waitUntil(() => !alive(pid));

    // ...and the dashboard accepts a new run once the old one is gone.
    await waitUntil(async () => (await ui.api("/api/ci/run", { steps: ["build"] })).status === 200);
  });

  it("/api/fix writes the fix only for the files asked for, and refuses paths outside the project", async () => {
    const outside = join(dir, "..", "lintlane-outside.js");
    const refused = await ui.api("/api/fix", { files: ["../lintlane-outside.js"] });
    assert.equal(refused.status, 500);
    assert.equal(existsSync(outside), false);

    const res = await ui.api("/api/fix", { files: ["a.js"] });
    assert.equal(res.status, 200);
    assert.equal(read(dir, "a.js"), "export const a = 1;\n");
    assert.equal((await (await ui.api("/api/check")).json()).files.length, 0);
    assert.equal((await ui.api("/api/fix", { files: [] })).status, 400);
  });
});

describe("lintlane ui startup errors", () => {
  it("fails with a clear message when the port is taken", async () => {
    const dir = makeProject();
    const first = await startDashboard(dir);
    try {
      const port = new URL(first.base).port;
      const { spawnSync } = await import("node:child_process");
      const second = spawnSync("node", [CLI, "ui", "--no-open", "--port", port], {
        cwd: dir,
        env: cleanEnv(),
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(second.status, 1);
      assert.match(second.stderr, /already in use/);
    } finally {
      first.child.kill("SIGKILL");
    }
  });
});
