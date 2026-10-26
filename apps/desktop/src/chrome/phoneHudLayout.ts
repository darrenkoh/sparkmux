/** Phone Stats shows one segment. The 3D map must not keep the desktop row under it. */

export function phoneMapFillsSegment(phoneLayout: boolean, phonePane: string): boolean {
  return phoneLayout && phonePane === "map";
}
