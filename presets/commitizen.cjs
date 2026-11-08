// Commitizen adapter: the standard Conventional Commits prompt, resolved from
// lintlane's own dependencies so it works under every package manager.
// package.json: "config": { "commitizen": { "path": "lintlane/presets/commitizen.cjs" } }
module.exports = require("cz-conventional-changelog");
