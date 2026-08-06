const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Metro's own default for this ends up walking past the workspace root under pnpm's
// strict node_modules layout and can land on an unrelated `metro-runtime` outside the
// project. Compute it from this file's own location, where `metro-runtime` is a
// direct dependency, so it always resolves to the right package.
config.resolver.emptyModulePath = require.resolve(
  "metro-runtime/src/modules/empty-module.js"
);

// Several Expo packages (@expo/vector-icons, @expo-google-fonts/*) import "react" and
// "react-native" without declaring them as dependencies — they rely on npm/yarn's flat
// hoisting to find a copy, which pnpm's strict node_modules doesn't provide. Metro's
// default directory-walking resolution then lands on whichever copy happens to be
// nearest on disk, which under this workspace can be a *different* React instance than
// the one this app renders with (packages/ui and apps/admin-dashboard pin react@19).
// Two React instances reconciling the same tree is exactly "Objects are not valid as a
// React child" / "Cannot read property 'useState' of null".
//
// `extraNodeModules` alone does NOT fix this: it is only a fallback Metro consults when
// normal resolution finds nothing, and normal resolution always finds *some* copy of
// react, so the fallback never triggers. `resolveRequest` intercepts the request before
// that default algorithm runs at all, so it is the only hook that actually forces every
// requirer — no matter how deeply nested in node_modules — onto this app's one copy.
const REACT_SINGLETONS = {
  react: path.resolve(__dirname, "node_modules/react"),
  "react-native": path.resolve(__dirname, "node_modules/react-native"),
};

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (Object.prototype.hasOwnProperty.call(REACT_SINGLETONS, moduleName)) {
    return { type: "sourceFile", filePath: require.resolve(moduleName, { paths: [__dirname] }) };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
