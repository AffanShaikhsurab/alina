import { Host, ProgressView } from "@expo/ui/swift-ui";
import { accessibilityLabel as accessibilityName, tint } from "@expo/ui/swift-ui/modifiers";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";

/** Native linear gauge of how full the context window is. */
export function ContextMeter({ fraction, label }: { fraction: number; label: string }) {
  const tokens = useMobileTokens();
  const scheme = useResolvedAppearance();
  return (
    <Host colorScheme={scheme} matchContents={{ vertical: true }} style={{ alignSelf: "stretch" }}>
      <ProgressView
        value={fraction}
        modifiers={[
          tint(fraction >= 0.9 ? tokens.warning : tokens.primary),
          accessibilityName(label),
        ]}
      />
    </Host>
  );
}
