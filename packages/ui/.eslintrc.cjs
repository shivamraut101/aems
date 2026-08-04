const preset = require("@aems/config/eslint-preset");

module.exports = {
  ...preset,
  parserOptions: {
    ...preset.parserOptions,
    ecmaFeatures: { jsx: true },
  },
  env: { ...preset.env, browser: true },
};
