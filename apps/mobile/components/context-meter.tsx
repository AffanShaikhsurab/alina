import { StyleSheet, View } from "react-native";
import { useMobileTokens } from "../lib/native";

/** Linear gauge of how full the context window is. iOS draws a SwiftUI progress view. */
export function ContextMeter({ fraction, label }: { fraction: number; label: string }) {
  const tokens = useMobileTokens();
  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
      style={[styles.track, { backgroundColor: tokens.muted }]}
    >
      <View
        style={[
          styles.fill,
          {
            width: `${Math.round(fraction * 100)}%`,
            backgroundColor: fraction >= 0.9 ? tokens.warning : tokens.primary,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { alignSelf: "stretch", height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2 },
});
