import type { ReactNode } from "react";
import type { AccessibilityState, Insets, StyleProp, ViewStyle } from "react-native";
import { Pressable } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  LayoutAnimationConfig,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { BezierCurve } from "../lib/motion-config";
import { EASE_IN_OUT, EASE_OUT, MOTION_DISTANCE, MOTION_MS } from "../lib/motion-config";

/** An Animated.View that takes `entering`, `exiting` and `layout`. */
export const MotionView = Animated.View;
/** `skipEntering` keeps a screen's first paint still; only later arrivals animate. */
export { LayoutAnimationConfig };

// Everything here is a timing curve that settles once: no springs, so nothing bounces.
// Layout animations and withTiming follow iOS Reduce Motion by default (ReduceMotion.System):
// they jump to their end state instead of moving.

const curve = ([x1, y1, x2, y2]: BezierCurve) => Easing.bezier(x1, y1, x2, y2);
export const easeOut = curve(EASE_OUT);
export const easeInOut = curve(EASE_IN_OUT);

/** A popover rising out of the composer, and the way it shrinks or grows as the list filters. */
export const popoverEntering = FadeInDown.duration(MOTION_MS.enter)
  .easing(easeOut)
  .withInitialValues({ transform: [{ translateY: MOTION_DISTANCE.popover }] });
export const popoverExiting = FadeOut.duration(MOTION_MS.exit).easing(easeInOut);
export const popoverLayout = LinearTransition.duration(MOTION_MS.layout).easing(easeOut);

/** A new message settling into place at the bottom of the thread. */
export const messageEntering = FadeInDown.duration(MOTION_MS.enter)
  .easing(easeOut)
  .withInitialValues({ transform: [{ translateY: MOTION_DISTANCE.message }] });

/** Small state lines and indicators that come and go. */
export const quietEntering = FadeIn.duration(180).easing(easeOut);
export const quietExiting = FadeOut.duration(140).easing(easeInOut);

/**
 * A control that gives under the finger: a quick eased scale on the UI thread, or a dim when
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
  const feedback = useAnimatedStyle(() => {
    const down = pressed.value === 1;
    const timing = { duration: down ? MOTION_MS.pressIn : MOTION_MS.pressOut, easing: easeOut };
    return reduceMotion
      ? { opacity: withTiming(down ? 0.6 : 1, timing) }
      : { transform: [{ scale: withTiming(down ? pressedScale : 1, timing) }] };
  });
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
