import { describe, expect, it } from 'vitest';
import { fileTypeBadgeTone } from '../../../../components/projects/files/fileTypeBadge';

describe('fileTypeBadgeTone', () => {
  it.each([
    ['3mf', 'source'],
    ['gcode', 'sliced'],
    ['gcode.3mf', 'sliced'],
    ['bgcode', 'other'],
    ['stl', 'other'],
    ['', 'other'],
    ['3MF', 'other'],
  ])('%s -> %s', (type, tone) => {
    expect(fileTypeBadgeTone(type)).toBe(tone);
  });
});
