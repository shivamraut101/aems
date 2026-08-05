// Must be the first import — Reanimated needs to install itself before anything
// else in the bundle runs.
import "react-native-reanimated";

import { registerRootComponent } from "expo";

import "./src/background-task";
import App from "./App";

registerRootComponent(App);
