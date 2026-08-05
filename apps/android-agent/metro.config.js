const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Metro's own default for this ends up walking past the workspace root under pnpm's
// strict node_modules layout and can land on an unrelated `metro-runtime` outside the
// project. Compute it from this file's own location, where `metro-runtime` is a
// direct dependency, so it always resolves to the right package.
config.resolver.emptyModulePath = require.resolve(
  "metro-runtime/src/modules/empty-module.js"
);

module.exports = config;
