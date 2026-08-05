const preset = require("@aems/config/eslint-preset");

module.exports = {
  ...preset,
  // The service worker and both pages run in a browser, not in Node. Declaring it here
  // rather than inheriting `node: true` alone is what makes `document`, `window` and
  // `URLSearchParams` known and `process` unknown.
  env: { ...preset.env, browser: true, worker: true },
  globals: { chrome: "readonly" },
  ignorePatterns: [...preset.ignorePatterns, "keys"],
};
