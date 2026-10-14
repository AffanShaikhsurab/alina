import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { View } from "react-native";
import type { ResolvedAppearance } from "../lib/appearance";

export type GlassSurfaceProps = {
  shape?: "capsule" | "circle" | "roundedRectangle";
  /** Corner radius for `roundedRectangle`. */
  cornerRadius?: number;
  /** Glass tint, e.g. for a selected or primary control. */
  tint?: string;
  /** Draws the glass for this appearance instead of the app's, e.g. on the always-dark call. */
  colorScheme?: ResolvedAppearance;
  style?: StyleProp<ViewStyle>;
  /** Applied where Liquid Glass is unavailable (Android, iOS before 26). */
  fallbackStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
};

/** Android and older iOS draw the fallback fill; iOS 26 renders Liquid Glass. */
export function GlassSurface({ style, fallbackStyle, children }: GlassSurfaceProps) {
  return <View style={[style, fallbackStyle]}>{children}</View>;
}
