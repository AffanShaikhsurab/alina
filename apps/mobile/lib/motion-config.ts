/**
 * Every animation in the app settles once: timing curves only, no springs that overshoot and
 * bounce back. `components/motion.tsx` builds the Reanimated presets from these numbers.
 */

/** A cubic bezier `[x1, y1, x2, y2]`; with both y within 0..1 it never passes its target. */
export type BezierCurve = readonly [number, number, number, number];

/** Fast out of the gate, gently into place: things arriving or settling. */
export const EASE_OUT: BezierCurve = [0.22, 1, 0.36, 1];
/** Symmetric: things leaving, and loops that breathe. */
export const EASE_IN_OUT: BezierCurve = [0.65, 0, 0.35, 1];

/** Durations in ms. */
export const MOTION_MS = {
  /** A popover, notice or message arriving. */
  enter: 240,
  /** The same leaving. */
  exit: 160,
  /** A popover growing or shrinking as its list filters. */
  layout: 220,
  /** A control pressed down, and let go. */
  pressIn: 90,
  pressOut: 160,
  /** The full-screen call rising over the chat. */
  sheetIn: 320,
  /** The call folding away after a tap (a drag sets its own pace, within these bounds). */
  sheetOut: 280,
  sheetOutMin: 160,
  /** Hang-up: the call fades back to the chat. */
  close: 220,
  /** A drag that did not go far enough, returning to place. */
  settle: 240,
} as const;

/** How far arriving things travel, in pt. */
export const MOTION_DISTANCE = { popover: 8, message: 12, pill: 8, close: 24 } as const;
