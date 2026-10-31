/** Build volumes of the printers the shop runs, by the names the slicer writes into a 3MF
 *  (`printer_model`, `sliced_for_model`, embedded presets). The viewer draws the bed at this
 *  size so an object outside the printable area is obvious. Unknown names fall back to 256³. */
export interface BuildVolume {
  x: number;
  y: number;
  z: number;
}

export const DEFAULT_BUILD_VOLUME: BuildVolume = { x: 256, y: 256, z: 256 };

const BEDS: Array<[RegExp, BuildVolume]> = [
  [/h2d/i, { x: 350, y: 320, z: 325 }],
  [/h2s/i, { x: 350, y: 320, z: 340 }],
  [/h2c/i, { x: 350, y: 320, z: 325 }],
  [/a1\s*mini/i, { x: 180, y: 180, z: 180 }],
  [/\ba1\b/i, { x: 256, y: 256, z: 256 }],
  [/x1|p1s|p1p|x1c|x1e/i, { x: 256, y: 256, z: 256 }],
];

/** The bed for a printer name, the first known name among the hints winning. */
export function buildVolumeFor(...hints: Array<string | null | undefined>): BuildVolume {
  for (const hint of hints) {
    if (!hint) continue;
    for (const [pattern, volume] of BEDS) if (pattern.test(hint)) return volume;
  }
  return DEFAULT_BUILD_VOLUME;
}
