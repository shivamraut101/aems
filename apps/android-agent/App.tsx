import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ConsentScreen } from "./src/screens/ConsentScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { useAgentState } from "./src/state";

/**
 * Root component. Two screens, swapped by hand instead of pulling in a router —
 * consent gates everything else, so "navigation" here is just "is consent done".
 */
export default function App() {
  const { status, refresh, acceptConsent } = useAgentState();
  const [screen, setScreen] = useState<"home" | "consent">("consent");

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setScreen(status.consentRequired ? "consent" : "home");
  }, [status.consentRequired]);

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {screen === "consent" ? (
        <ConsentScreen
          status={status}
          onAccept={acceptConsent}
          onAccepted={() => setScreen("home")}
        />
      ) : (
        <HomeScreen status={status} />
      )}
    </SafeAreaProvider>
  );
}
