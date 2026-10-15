import { MOTION_MS } from "./motion-config";

/** Past this share of the screen, letting go folds the call away. */
export const CALL_DISMISS_DISTANCE = 0.25;
/** A downward flick this fast (pt/s) folds it away from any distance. */
export const CALL_DISMISS_VELOCITY = 1_000;
/** How far an upward drag can stretch the call, in pt. */
export const CALL_UPWARD_STRETCH = 40;

/** Where the call sits for a vertical drag: 1:1 downwards, a short rubber band upwards. */
export function callDragOffset(translation: number): number {
  "worklet";
  if (translation >= 0) return translation;
  const pull = -translation;
  return -CALL_UPWARD_STRETCH * (1 - 1 / (pull / CALL_UPWARD_STRETCH + 1));
}

/**
 * On release: minimise when dragged past a quarter of the screen, or flicked down fast, unless
 * the finger was heading back up when it let go.
 */
export function callDragMinimizes(offset: number, velocity: number, height: number): boolean {
  "worklet";
  if (offset <= 0 || height <= 0) return false;
  if (velocity < -200) return false;
  return offset > height * CALL_DISMISS_DISTANCE || velocity > CALL_DISMISS_VELOCITY;
}

/**
 * How long the call takes to cover what is left of the way down: a flick carries its speed, a
 * slow release or a tap uses the regular duration.
 */
export function callSlideDuration(remaining: number, velocity: number, height: number): number {
  "worklet";
  if (height <= 0 || remaining <= 0) return MOTION_MS.sheetOutMin;
  const regular = MOTION_MS.sheetOut * Math.min(1, remaining / height);
  // An ease-out curve starts about three times faster than its average speed.
  const carried = velocity > 0 ? ((remaining * 3) / velocity) * 1_000 : regular;
  return Math.round(
    Math.min(MOTION_MS.sheetOut, Math.max(MOTION_MS.sheetOutMin, Math.min(regular, carried))),
  );
}
