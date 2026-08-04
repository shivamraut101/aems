module.exports = {
  extends: [require.resolve("@aems/config/eslint-preset")],
  parserOptions: {
    ecmaFeatures: { jsx: true },
  },
  env: {
    browser: true,
  },
};
