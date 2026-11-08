// Shared commitlint config: Conventional Commits, tuned by the optional
// "lintlane.commit" block in package.json:
//
//   "lintlane": { "commit": { "types": ["feat", "fix"], "messageLengthLimit": 72,
//                             "allowedPrefixes": ["WIP"] } }
//
// A project's commitlint.config.mjs can be just:
//   export { default } from "lintlane/commitlint";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

function readOptions() {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const commit = pkg?.lintlane?.commit;
    return commit && typeof commit === "object" ? commit : {};
  } catch {
    return {};
  }
}

const options = readOptions();
const rules = {};

if (Array.isArray(options.types) && options.types.length > 0) {
  rules["type-enum"] = [2, "always", options.types.map((t) => String(Array.isArray(t) ? t[0] : t))];
} else if (options.types && typeof options.types === "object" && !Array.isArray(options.types)) {
  rules["type-enum"] = [2, "always", Object.keys(options.types)];
}

const limit = Number(options.messageLengthLimit);
if (options.messageLengthLimit !== undefined && Number.isFinite(limit) && limit >= 0) {
  rules["header-max-length"] = limit === 0 ? [0] : [2, "always", limit];
}

const prefixes = Array.isArray(options.allowedPrefixes) ? options.allowedPrefixes.map(String) : [];

export default {
  extends: [require.resolve("@commitlint/config-conventional")],
  rules,
  ...(prefixes.length > 0
    ? { ignores: [(message) => prefixes.some((prefix) => String(message).startsWith(prefix))] }
    : {}),
};
