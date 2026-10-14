import type { ReactNode } from "react";
import type { AccessibilityState, Insets, StyleProp, ViewStyle } from "react-native";
import { Pressable } from "react-native";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  LayoutAnimationConfig,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

/** An Animated.View that takes `entering`, `exiting` and `layout`. */
export const MotionView = Animated.View;
/** `skipEntering` keeps a screen's first paint still; only later arrivals animate. */
export { LayoutAnimationConfig };

// Layout animations follow iOS Reduce Motion by default (ReduceMotion.System): they jump to
// their end state instead of moving.

/** A popover rising out of the composer, and the way it shrinks or grows as the list filters. */
export const popoverEntering = FadeInDown.springify().damping(22).stiffness(260);
export const popoverExiting = FadeOut.duration(120);
export const popoverLayout = LinearTransition.springify().damping(24).stiffness(260);

/** A new message settling into place at the bottom of the thread. */
export const messageEntering = FadeInDown.springify().damping(20).stiffness(200);

/** Small state lines and indicators that come and go. */
export const quietEntering = FadeIn.duration(180);
export const quietExiting = FadeOut.duration(140);

const PRESS_SPRING = { damping: 18, stiffness: 420, mass: 0.6 };

/**
 * A control that gives under the finger: a quick spring scale on the UI thread, or a dim when
 * Reduce Motion is on. `haptic` runs on press, before `onPress`.
 */
export function PressScale({
  children,
  onPress,
  disabled,
  haptic,
  pressedScale = 0.92,
  style,
  containerStyle,
  accessibilityLabel,
  accessibilityState,
  hitSlop,
  testID,
}: {
  children: ReactNode;
  onPress: () => void;
  disabled?: boolean;
  haptic?: () => void;
  pressedScale?: number;
  style?: StyleProp<ViewStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel: string;
  accessibilityState?: AccessibilityState;
  hitSlop?: number | Insets;
  testID?: string;
}) {
  const reduceMotion = useReducedMotion();
  const pressed = useSharedValue(0);
  const feedback = useAnimatedStyle(() =>
    reduceMotion
      ? { opacity: withTiming(pressed.value ? 0.6 : 1, { duration: 90 }) }
      : { transform: [{ scale: withSpring(pressed.value ? pressedScale : 1, PRESS_SPRING) }] },
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      disabled={disabled}
      hitSlop={hitSlop}
      testID={testID}
      style={containerStyle}
      onPressIn={() => {
        pressed.value = 1;
      }}
      onPressOut={() => {
        pressed.value = 0;
      }}
      onPress={() => {
        haptic?.();
        onPress();
      }}
    >
      <Animated.View style={[style, feedback]}>{children}</Animated.View>
    </Pressable>
  );
}
