/** Scale a base font size by the given multiplier, rounding to nearest integer */
export function scaledFont(base: number, scale: number): number {
  return Math.round(base * scale);
}
