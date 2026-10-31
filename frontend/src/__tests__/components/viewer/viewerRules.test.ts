/** The part viewer's pure rules: bed sizes by printer name, the checks card, and which files
 *  a subject shows on which tab. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BUILD_VOLUME, buildVolumeFor } from '../../../components/viewer/printerBeds';
import { runChecks } from '../../../components/viewer/viewerChecks';
import { nozzleLabel, sourcesForArchive, sourcesForLibrary, sourcesForRevision } from '../../../components/viewer/partSources';
import { DEFAULT_DISPLAY_PREFS, DISPLAY_PREFS_KEY, decodeViewerState, encodeViewerState, readDisplayPrefs, writeDisplayPrefs } from '../../../components/viewer/viewerLink';
import { file, item, rev } from '../../fixtures/projectTree';

describe('printerBeds', () => {
  it('sizes the bed from the first known printer name among the hints', () => {
    expect(buildVolumeFor('Bambu Lab H2S')).toEqual({ x: 350, y: 320, z: 340 });
    expect(buildVolumeFor(null, undefined, 'Bambu Lab A1 mini')).toEqual({ x: 180, y: 180, z: 180 });
    expect(buildVolumeFor('Bambu Lab A1')).toEqual({ x: 256, y: 256, z: 256 });
    expect(buildVolumeFor('X1C')).toEqual({ x: 256, y: 256, z: 256 });
  });
  it('falls back to 256³ for an unknown or missing name', () => {
    expect(buildVolumeFor('Prusa MK4')).toEqual(DEFAULT_BUILD_VOLUME);
    expect(buildVolumeFor()).toEqual(DEFAULT_BUILD_VOLUME);
  });
});

describe('viewerChecks', () => {
  const volume = { x: 256, y: 256, z: 256 };
  it('reports a part inside the bed, no supports and the newest revision as green', () => {
    const checks = runChecks({ bbox: { min: [10, 10, 0], max: [100, 80, 30] }, volume, sliced: true, supportShare: 0, outdatedBy: null, filaments: ['A1 · PETG'] });
    expect(checks.map((c) => `${c.id}:${c.level}:${c.key}`)).toEqual(['bed:ok:insideBed', 'supports:ok:noSupports', 'revision:ok:newest', 'filaments:info:filaments']);
    expect(checks[3].params).toEqual({ list: 'A1 · PETG' });
  });
  it('warns when the part leaves the printable area, is not sliced, uses supports or is outdated', () => {
    const checks = runChecks({ bbox: { min: [-5, 0, 0], max: [300, 80, 30] }, volume, sliced: false, supportShare: 0.12, outdatedBy: 'R2', filaments: [] });
    expect(checks.map((c) => `${c.id}:${c.level}`)).toEqual(['bed:warn', 'sliced:warn', 'supports:info', 'revision:warn']);
    expect(checks.find((c) => c.id === 'supports')?.params).toEqual({ pct: 12 });
    expect(checks.find((c) => c.id === 'revision')?.params).toEqual({ by: 'R2' });
  });
  it('says nothing it cannot know: no bbox, unknown slicing, no toolpath, an archive (no revision)', () => {
    expect(runChecks({ bbox: null, volume, sliced: null, supportShare: null, outdatedBy: undefined as unknown as null, filaments: [] })).toEqual([]);
  });
});

describe('partSources', () => {
  it('a plain 3MF in the library: model only, with plates', () => {
    const s = sourcesForLibrary({ kind: 'library', fileId: 5, fileType: '3mf', filename: 'part.3mf' });
    expect(s.model).toEqual({ url: '/api/v1/library/files/5/download', fileType: '3mf' });
    expect(s.toolpath).toBeNull();
    expect(s.plates).toEqual({ kind: 'library', fileId: 5 });
  });
  it('a sliced .gcode.3mf in the library: BOTH the mesh and the toolpath (the bug this fixes)', () => {
    const s = sourcesForLibrary({ kind: 'library', fileId: 6, fileType: 'gcode.3mf', filename: 'part.gcode.3mf' });
    expect(s.model).toEqual({ url: '/api/v1/library/files/6/download', fileType: '3mf' });
    expect(s.toolpath).toEqual({ url: '/api/v1/library/files/6/gcode' });
  });
  it('a bare .gcode: toolpath only; an STL: model only, no plates', () => {
    expect(sourcesForLibrary({ kind: 'library', fileId: 7, fileType: 'gcode', filename: 'part.gcode' })).toMatchObject({ model: null, toolpath: { url: '/api/v1/library/files/7/gcode' }, plates: null });
    expect(sourcesForLibrary({ kind: 'library', fileId: 8, fileType: 'stl', filename: 'part.stl' })).toMatchObject({ model: { fileType: 'stl' }, toolpath: null, plates: null });
  });
  it('an archive follows its capabilities: source 3MF for the model, G-code when sliced', () => {
    const s = sourcesForArchive({ kind: 'archive', archiveId: 9, filename: 'job.3mf' }, { has_model: true, has_gcode: true, has_source: true });
    expect(s.model?.url).toContain('/archives/9/');
    expect(s.toolpath).toEqual({ url: '/api/v1/archives/9/gcode' });
    expect(sourcesForArchive({ kind: 'archive', archiveId: 9, filename: 'job.3mf' }, { has_model: false, has_gcode: false, has_source: false })).toMatchObject({ model: null, toolpath: null });
  });
  it('a revision: the source .3mf is the model, the sliced file the toolpath, its facts and plates', () => {
    const sliced = file(90, 'bracket.gcode.3mf', { file_type: 'gcode.3mf', print_time_seconds: 8040, filament_used_grams: 38.4, sliced_for_model: 'Bambu Lab H2S' });
    const revision = rev({ id: 2, number: 2, print_profile: { printer_model: 'Bambu Lab X1C' }, files: [file(51, 'bracket.3mf', { file_type: '3mf', file_size: 3000 })], sliced_file: sliced });
    const s = sourcesForRevision({ kind: 'revision', projectId: 7, item: item(20, 'impression', 'Bracket', [revision]), revision });
    expect(s.model).toEqual({ url: '/api/v1/library/files/51/download', fileType: '3mf' });
    expect(s.toolpath).toEqual({ url: '/api/v1/library/files/90/gcode' });
    expect(s.plates).toEqual({ kind: 'library', fileId: 90 });
    expect(s.facts?.print_time_seconds).toBe(8040);
    expect(s.printerHints).toEqual(['Bambu Lab X1C', 'Bambu Lab H2S']);
    expect(s.files.map((f) => `${f.role}:${f.id}`)).toEqual(['source:51', 'sliced:90']);
  });
  it('a revision uploaded already sliced (no source): the sliced file gives both tabs', () => {
    const only = file(91, 'bracket.gcode.3mf', { file_type: 'gcode.3mf', print_time_seconds: 100 });
    const revision = rev({ id: 3, files: [only], sliced_file: null });
    const s = sourcesForRevision({ kind: 'revision', projectId: 7, item: item(20, 'impression', 'Bracket', [revision]), revision });
    expect(s.model).toEqual({ url: '/api/v1/library/files/91/download', fileType: '3mf' });
    expect(s.toolpath).toEqual({ url: '/api/v1/library/files/91/gcode' });
    expect(s.files).toEqual([{ id: 91, filename: 'bracket.gcode.3mf', size: 2048, role: 'sliced' }]);
  });
  it('an unsliced revision: model only, no facts', () => {
    const revision = rev({ id: 4, files: [file(52, 'bracket.3mf', { file_type: '3mf' })] });
    const s = sourcesForRevision({ kind: 'revision', projectId: 7, item: item(20, 'impression', 'Bracket', [revision]), revision });
    expect(s.toolpath).toBeNull();
    expect(s.facts).toBeNull();
  });
});

describe('nozzleLabel', () => {
  it('takes the first known figure: profile string, file fact, archive column, embedded preset', () => {
    expect(nozzleLabel('0.4', null)).toBe('0.4 mm');
    expect(nozzleLabel(undefined, 0.6)).toBe('0.6 mm');
    expect(nozzleLabel(null, null, null, 'Bambu Lab H2C 0.4 nozzle')).toBe('0.4 mm');
    expect(nozzleLabel(null, null, null, 'Bambu Lab H2S')).toBeNull();
    expect(nozzleLabel('', 0, null)).toBeNull();
  });
});

describe('viewerLink', () => {
  const base = { bbox: null, volume: { x: 256, y: 256, z: 256 }, sliced: null, supportShare: null, outdatedBy: undefined as unknown as null, filaments: [] };
  it('round-trips the whole state through a URL-safe token', () => {
    const state = {
      tab: 'toolpath' as const, view: { dir: [0.3, 0.6, 0.742] as [number, number, number], target: [120, 20, -160] as [number, number, number], dist: 512.5, ortho: true, half: 88 },
      layers: [3, 120] as [number, number], hidden: [2, 5], style: 'hiddenEdges' as const, xray: true, explode: 0.6, section: { on: true, axis: 'x' as const, pct: 40 },
      overhang: { on: true, deg: 60 }, thinWalls: { on: true, mm: 1.2 },
    };
    const token = encodeViewerState(state);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeViewerState(token)).toEqual(state);
  });
  it('writes nothing for the defaults and ignores damaged or foreign tokens', () => {
    expect(decodeViewerState(encodeViewerState({ style: 'shaded', xray: false, explode: 0, hidden: [] }))).toEqual({});
    expect(decodeViewerState('not-a-token')).toBeNull();
    expect(decodeViewerState(null)).toBeNull();
    expect(decodeViewerState(btoa('[1,2]'))).toBeNull();
    // A half-valid token keeps the good fields and drops the rest.
    expect(decodeViewerState(btoa(JSON.stringify({ t: 1, s: 99, e: 7, d: [0, 1, 0], c: [0, 0], r: 10 })))).toEqual({ tab: 'toolpath' });
  });
  it('the analyses add their own checks only while they run', () => {
    const none = runChecks({ ...base, outdatedBy: null });
    expect(none.map((c) => c.id)).not.toContain('overhangs');
    const on = runChecks({ ...base, outdatedBy: null, overhangs: { share: 0.12, deg: 45 }, thinWalls: { share: 0.002, mm: 0.8 } });
    expect(on.find((c) => c.id === 'overhangs')).toMatchObject({ level: 'warn', key: 'overhangs', params: { pct: 12, deg: 45 } });
    expect(on.find((c) => c.id === 'thinWalls')).toMatchObject({ level: 'ok', key: 'noThinWalls', params: { mm: 0.8 } });
    const thin = runChecks({ ...base, outdatedBy: null, thinWalls: { share: 0.031, mm: 1.2 } });
    expect(thin.find((c) => c.id === 'thinWalls')).toMatchObject({ level: 'warn', params: { pct: 3.1, mm: 1.2 } });
  });
});

describe('display preferences', () => {
  it('round-trip through localStorage, with the defaults for anything missing or odd', () => {
    window.localStorage.removeItem(DISPLAY_PREFS_KEY);
    expect(readDisplayPrefs()).toEqual(DEFAULT_DISPLAY_PREFS);
    const render = { shadows: false, ao: true, finish: 'glossy' as const, reflections: 'strong' as const, background: 'light' as const };
    writeDisplayPrefs({ style: 'edges', grid: false, ortho: true, overhang: { on: true, deg: 60 }, thinWalls: { on: false, mm: 1.2 }, render });
    expect(readDisplayPrefs()).toEqual({ style: 'edges', grid: false, ortho: true, overhang: { on: true, deg: 60 }, thinWalls: { on: false, mm: 1.2 }, render });
    window.localStorage.setItem(DISPLAY_PREFS_KEY, JSON.stringify({ render: { finish: 'chrome', ao: 'yes', background: 'light' } }));
    expect(readDisplayPrefs().render).toEqual({ ...DEFAULT_DISPLAY_PREFS.render, background: 'light' });
    window.localStorage.setItem(DISPLAY_PREFS_KEY, JSON.stringify({ style: 'neon', grid: 'yes', overhang: { on: 1, deg: 400 } }));
    expect(readDisplayPrefs()).toEqual(DEFAULT_DISPLAY_PREFS);
    window.localStorage.setItem(DISPLAY_PREFS_KEY, '{broken');
    expect(readDisplayPrefs()).toEqual(DEFAULT_DISPLAY_PREFS);
    window.localStorage.removeItem(DISPLAY_PREFS_KEY);
  });
});

