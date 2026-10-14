import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

// iOS already skips these when the user turned System Haptics off.
const supported = Platform.OS === "ios" || Platform.OS === "android";

/** A light tick for picking something: a command, a model, a menu choice. */
export function selectionHaptic(): void {
  if (supported) void Haptics.selectionAsync().catch(() => undefined);
}

/** A tap on a primary control: send, call, mute. */
export function tapHaptic(): void {
  if (supported) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

/** Something the user asked for went through. */
export function successHaptic(): void {
  if (supported) {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
  }
}

/** Something the user asked for did not happen. */
export function errorHaptic(): void {
  if (supported) {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
  }
}
