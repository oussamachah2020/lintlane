import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { detectPackageManager, installCommand, PACKAGE_MANAGERS } from "./project.mjs";

export async function initTests(cwd, options = {}) {
  const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const pm = detectPackageManager(cwd, pkg).name;
  const run = `${pm} run`;
  pkg.scripts ??= {};
  const scripts = pkg.scripts;
  const react = Boolean(deps.react);
  const web = react || Boolean(deps.vite || deps.next);
  const existing =
    Object.keys(deps).some((name) => /^(vitest|jest|@jest\/core)$/.test(name)) ||
    Boolean(scripts.test && !/no test specified/.test(scripts.test));
  const files = new Map();
  const packages = [];
  const add = (name) => {
    if (!deps[name]) packages.push(name);
  };
  if (
    !existing &&
    [
      "vitest.config.ts",
      "vitest.config.js",
      "vitest.config.mjs",
      "jest.config.js",
      "jest.config.ts",
      "jest.config.cjs",
    ].some((file) => existsSync(join(cwd, file)))
  )
    throw new Error(
      "Existing test configuration needs a test script; configure it before rerunning init-tests.",
    );
  if (existing && !scripts.test)
    throw new Error(
      "Existing test runner detected: add a test script before rerunning init-tests.",
    );
  if (!existing) {
    add("vitest");
    if (react)
      for (const name of [
        "jsdom",
        "@testing-library/react",
        "@testing-library/jest-dom",
        "@vitejs/plugin-react",
      ])
        add(name);
    scripts.test = "vitest run";
    scripts["test:watch"] ??= "vitest";
    files.set(
      "vitest.config.mjs",
      `import { defineConfig } from 'vitest/config';\n${react ? "import react from '@vitejs/plugin-react';\n" : ""}export default defineConfig({ ${react ? "plugins: [react()], " : ""}test: { environment: '${react ? "jsdom" : "node"}', include: ['tests/unit/**/*.test.{js,jsx,ts,tsx}'] } });\n`,
    );
    files.set(
      "tests/unit/example.test.js",
      "import { expect, test } from 'vitest';\ntest('example: replace with application behavior', () => { expect(2 + 2).toBe(4); });\n",
    );
    if (react)
      files.set(
        "tests/unit/component.test.jsx",
        "import React from 'react';\nimport { expect, test } from 'vitest';\nimport { render, fireEvent, cleanup } from '@testing-library/react';\ntest('button interaction', () => { let clicked = false; const view = render(<button onClick={() => { clicked = true; }}>Continue</button>); try { fireEvent.click(view.getByRole('button')); expect(clicked).toBe(true); } finally { cleanup(); } });\n",
      );
  }
  const browser =
    web &&
    !deps["@playwright/test"] &&
    !scripts["test:e2e"] &&
    !["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"].some((file) =>
      existsSync(join(cwd, file)),
    );
  if (browser) {
    if (!scripts.dev)
      throw new Error("Browser setup requires a dev script. Add one before running init-tests.");
    add("@playwright/test");
    scripts["test:e2e"] = "playwright test";
    const port = deps.next || deps["@remix-run/react"] ? 3000 : 5173;
    files.set(
      "playwright.config.mjs",
      `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests/e2e', retries: 0, use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:${port}', trace: 'retain-on-failure' }, reporter: [['list'], ['html', { open: 'never' }]], webServer: { command: ${JSON.stringify(deps.next && scripts.build && scripts.start ? `process.env.CI ? '${run} build && ${run} start' : '${run} dev'` : null) ?? "null"}, url: 'http://127.0.0.1:${port}', reuseExistingServer: !process.env.CI } });\n`.replace(
        /command: .*?, url:/,
        `command: ${deps.next && scripts.build && scripts.start ? `process.env.CI ? '${run} build && ${run} start' : '${run} dev'` : `'${run} dev'`}, url:`,
      ),
    );
    files.set(
      "tests/e2e/smoke.spec.js",
      "import { test, expect } from '@playwright/test';\ntest('application responds', async ({ page }) => { const response = await page.goto('/'); expect(response.ok()).toBe(true); });\n",
    );
  }
  if (!options["no-ci"])
    files.set(
      ".github/workflows/tests.yml",
      `name: Tests\non: [push, pull_request]\njobs:\n  tests:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n${PACKAGE_MANAGERS[pm].setupSteps.join("\n")}\n      - run: ${run} test\n${scripts["test:e2e"] ? `      - run: ${pm === "npm" ? "npx" : pm === "yarn" ? "yarn" : pm === "bun" ? "bunx" : `${pm} exec`} playwright install --with-deps chromium\n      - run: ${run} test:e2e\n      - uses: actions/upload-artifact@v4\n        if: failure()\n        with:\n          name: playwright-report\n          path: playwright-report/\n` : ""}`,
    );
  for (const [file, content] of files) {
    const target = join(cwd, file);
    if (existsSync(target)) {
      console.log(`Preserved ${file}`);
      continue;
    }
    console.log(`Create ${file}`);
    if (!options["dry-run"]) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
  console.log(`Missing dependencies: ${packages.join(", ") || "none"}`);
  if (options["dry-run"]) return;
  await writeFile(join(cwd, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  if (packages.length && !options["skip-install"]) {
    const [command, ...args] = installCommand(pm, packages);
    const result = spawnSync(command, args, { cwd, stdio: "inherit" });
    if (result.error || result.status !== 0)
      throw new Error("Testing dependency installation failed; rerun init-tests to retry.");
  }
  if (browser)
    console.log(
      "Install local browsers: run playwright install chromium through your package manager.",
    );
}
