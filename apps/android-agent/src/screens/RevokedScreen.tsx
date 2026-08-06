import { Feather } from "@expo/vector-icons";
import { StyleSheet, View } from "react-native";

import { ListRow, ListSection } from "../components/List";
import { Screen } from "../components/Screen";
import { useTheme } from "../theme";

/**
 * Shown when an administrator has stopped this device.
 *
 * This screen exists because of what used to happen instead: `sync.ts` cleared the
 * credentials and the employee was returned to the sign-in form with no explanation,
 * which reads as the app breaking rather than as a decision somebody made. The desktop
 * agent has always said so plainly; this is the same account, in the same words, on the
 * surface a phone user actually has.
 *
 * There is no action on it, on purpose. Nothing the employee can do from here would
 * change the outcome — re-enrolling needs a new code, and issuing one is the
 * administrator's call — so a button would only offer a dead end. The useful thing it
 * can do is name who to ask.
 */
export function RevokedScreen({ policyVersion }: { policyVersion: string | null }) {
  const theme = useTheme();
  const styles = createStyles(theme);

  return (
    <Screen
      title="Monitoring has been stopped"
      subtitle="An administrator revoked this device, so nothing is being recorded or sent. Contact them if you think this is a mistake."
      tabbed={false}
    >
      <View style={styles.iconWrap}>
        <Feather name="slash" size={26} color={theme.colors.amber} />
      </View>

      <ListSection
        heading="What this means"
        footnote={policyVersion ? `Last policy in force · version ${policyVersion}` : undefined}
      >
        <ListRow
          icon="pause-circle"
          label="Collection has stopped"
          detail="Nothing further is being recorded on this phone."
        />
        <ListRow
          icon="database"
          label="Your existing record is intact"
          detail="Work already recorded stays in your company's records, and you can still read it from the AEMS dashboard."
        />
        <ListRow
          icon="key"
          label="To use this phone for work again"
          detail="Ask your administrator for a new sign-in code."
        />
      </ListSection>
    </Screen>
  );
}

function createStyles(theme: ReturnType<typeof useTheme>) {
  const { colors, spacing } = theme;

  return StyleSheet.create({
    iconWrap: {
      width: 56,
      height: 56,
      borderRadius: 16,
      alignSelf: "center",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.warningSurface,
      marginTop: spacing.sm,
    },
  });
}
