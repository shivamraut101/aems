/**
 * Pins the Java import autolinking generates for the `expo` package.
 *
 * Autolinking derives an import from a library's Gradle `namespace` when it cannot
 * read that library's own `react-native.config.js`. For `expo` those two disagree:
 * `node_modules/expo/android/build.gradle` declares `namespace "expo.core"`, but the
 * class is `expo.modules.ExpoModulesPackage`. Expo ships a `react-native.config.js`
 * that overrides exactly this — and under pnpm it does not always get applied, because
 * `expo-modules-autolinking` is resolved *through* `expo`, and this workspace has two
 * copies of `expo` in the store for peer-dependency reasons.
 *
 * The result is a generated `PackageList.java` importing `expo.core.ExpoModulesPackage`
 * and a build that fails with "cannot find symbol" — in *both* debug and release, and
 * only after a dependency change reshuffles which copy is reachable. Stating the fact
 * here makes it independent of that resolution.
 *
 * Safe to delete once the duplicate `expo` is gone (`pnpm why expo` shows one copy) and
 * a clean build still resolves `expo.modules.ExpoModulesPackage`.
 */
module.exports = {
  dependencies: {
    expo: {
      platforms: {
        android: {
          packageImportPath: "import expo.modules.ExpoModulesPackage;",
          packageInstance: "new ExpoModulesPackage()",
        },
      },
    },
  },
};
