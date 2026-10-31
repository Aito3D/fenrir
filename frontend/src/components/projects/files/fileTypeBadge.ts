type FileTypeBadgeTone = 'source' | 'sliced' | 'other';

/** Which colour family a file-type badge takes: source .3mf, sliced (gcode / gcode.3mf), anything else. */
export function fileTypeBadgeTone(fileType: string): FileTypeBadgeTone {
  if (fileType === '3mf') return 'source';
  if (fileType === 'gcode' || fileType === 'gcode.3mf') return 'sliced';
  return 'other';
}
