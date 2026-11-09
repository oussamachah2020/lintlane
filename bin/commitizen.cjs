// Commitizen treats unscoped package subpaths as paths relative to the git root.
// Resolve our adapter from this installation before handing control to its CLI.
const { dirname } = require("node:path");

process.on("uncaughtException", (error) => {
  console.error(error.message || error);
  process.exit(1);
});
process.stdin.on("data", (key) => {
  if (key.toString() === "\u0003") process.exit(130);
});

const { configLoader } = require("commitizen");
const config = configLoader.load();
const bundledPaths = ["lintlane/presets/commitizen.cjs", "lintlane/commitizen"];
const resolvedConfig = bundledPaths.includes(config?.path)
  ? { ...config, path: require.resolve("../presets/commitizen.cjs") }
  : config;

require("commitizen/dist/cli/git-cz.js").bootstrap({
  cliPath: dirname(require.resolve("commitizen/package.json")),
  config: resolvedConfig,
});
