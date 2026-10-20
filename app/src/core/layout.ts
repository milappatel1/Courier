// Window width classes (pure; the store follows the window with these).

export type ViewSize = "wide" | "medium" | "phone";

/** ≥ 1024: desktop; 700–1023: the nav becomes a rail; below 700: the phone app's layout. */
export function sizeFor(width: number): ViewSize {
  return width < 700 ? "phone" : width < 1024 ? "medium" : "wide";
}
