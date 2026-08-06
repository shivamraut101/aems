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

// This workspace contains two Reacts: this app renders with react@18.3.1 (what
// react-native@0.76 bundles a reconciler for), while packages/ui and the dashboard pin
// react@19. Under pnpm's strict node_modules a package that imports React *without
// declaring it* — @expo/vector-icons and @expo-google-fonts/* both do; check their
// package.json, neither lists react — gets whichever copy Metro's directory walk finds
// first. When that is react@19, the app crashes, and the two faces it wears are:
//
//   "Cannot read property 'recentlyCreatedOwnerStacks' of undefined"
//   "Objects are not valid as a React child (found: object with keys {$$typeof, ...})"
//
// Both are one bug. React 19 tags elements `Symbol.for('react.transitional.element')`;
// React 18's reconciler only accepts `Symbol.for('react.element')`, so a React-19-made
// element reaching React Native's renderer is, quite literally, an unrecognised object.
//
// Two traps this has already fallen into, so don't "simplify" it back:
//
//  1. `extraNodeModules` does nothing here. It is a *fallback* Metro consults only when
//     normal resolution finds nothing, and normal resolution always finds some react.
//  2. Matching the exact strings "react"/"react-native" is not enough. Expo's preset
//     uses the automatic JSX runtime, so every .tsx file imports `react/jsx-dev-runtime`
//     — a subpath, which sails past an equality check and lands back on react@19. The
//     prefix match below is the entire point.
//
// Rather than hand-build a file path, this re-runs Metro's own resolution with the
// requester rewritten to this app — so subpaths, "exports" maps and platform-specific
// files all keep working, and every requirer lands on one React no matter how deeply
// nested it sits in node_modules.
const SINGLETONS = ["react", "react-native"];
const APP_ORIGIN = path.join(__dirname, "metro.config.js");

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const pinned = SINGLETONS.some(
    (pkg) => moduleName === pkg || moduleName.startsWith(`${pkg}/`),
  );

  return context.resolveRequest(
    pinned ? { ...context, originModulePath: APP_ORIGIN } : context,
    moduleName,
    platform,
  );
};

module.exports = config;
