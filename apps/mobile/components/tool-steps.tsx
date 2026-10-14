import type { MessageBlock } from "@rakazo/contracts";
import { Text, View } from "react-native";
import { useMobileTokens } from "../lib/native";
import { toolStepsText } from "../lib/subagent";
import { NativeSymbol } from "./native-symbol";

/** One muted line for a turn's tool calls, shown when the chat turns tool steps on. */
export function ToolStepsLine({ block }: { block: Extract<MessageBlock, { kind: "steps" }> }) {
  const tokens = useMobileTokens();
  const text = toolStepsText(block.steps);
  if (!text) return null;
  return (
    <View
      accessible
      accessibilityLabel={text}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 }}
    >
      <NativeSymbol
        ios="wrench.and.screwdriver"
        android="construct-outline"
        size={12}
        color={tokens.mutedForeground}
      />
      <Text style={{ color: tokens.mutedForeground, fontSize: 13, flexShrink: 1 }}>{text}</Text>
    </View>
  );
}
