import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTests } from "../bin/init-tests.mjs";

test("testing setup dry run, generation and idempotency", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lintlane-tests-"));
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture" }));
    await initTests(dir, { "dry-run": true });
    assert.deepEqual(await readdir(dir), ["package.json"]);
    await initTests(dir, { "skip-install": true });
    const first = await readFile(join(dir, "package.json"), "utf8");
    assert.equal(JSON.parse(first).scripts.test, "vitest run");
    await initTests(dir, { "skip-install": true });
    assert.equal(await readFile(join(dir, "package.json"), "utf8"), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing project test script is preserved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lintlane-tests-"));
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    await initTests(dir, { "skip-install": true, "no-ci": true });
    assert.equal(
      JSON.parse(await readFile(join(dir, "package.json"), "utf8")).scripts.test,
      "node --test",
    );
    assert.deepEqual((await readdir(dir)).sort(), ["package.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
