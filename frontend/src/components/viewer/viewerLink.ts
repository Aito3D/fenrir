/** The view a copied link carries (proposition 10): camera, tab, layers, hidden features and
 *  the display settings, packed into one `v=` query parameter so a colleague opens the same
 *  view. Pure: encode/decode only. */

export type VisualStyle = 'shaded' | 'edges' | 'hiddenEdges' | 'wireframe' | 'polygons';

export interface SceneView {
  /** Unit vector from the target to the camera (three.js frame). */
  dir: [number, number, number];
  target: [number, number, number];
  dist: number;
  ortho: boolean;
  /** Half the orthographic frustum's height, so the apparent size is kept. */
  half: number;
}

export interface ViewerLinkState {
  tab?: 'model' | 'toolpath';
  view?: SceneView;
  layers?: [number, number];
  hidden?: number[];
  style?: VisualStyle;
  xray?: boolean;
  explode?: number;
  section?: { on: boolean; axis: 'x' | 'y' | 'z'; pct: number };
  overhang?: { on: boolean; deg: number };
  thinWalls?: { on: boolean; mm: number };
}

const STYLES: VisualStyle[] = ['shaded', 'edges', 'hiddenEdges', 'wireframe', 'polygons'];
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** A compact, URL-safe token; only the fields that differ from the defaults are written. */
export function encodeViewerState(state: ViewerLinkState): string {
  const out: Record<string, unknown> = {};
  if (state.tab) out.t = state.tab === 'toolpath' ? 1 : 0;
  if (state.view) {
    out.d = state.view.dir.map(r3);
    out.c = state.view.target.map(r3);
    out.r = r3(state.view.dist);
    if (state.view.ortho) {
      out.o = 1;
      out.h = r3(state.view.half);
    }
  }
  if (state.layers) out.l = state.layers;
  if (state.hidden && state.hidden.length) out.f = state.hidden;
  if (state.style && state.style !== 'shaded') out.s = STYLES.indexOf(state.style);
  if (state.xray) out.x = 1;
  if (state.explode) out.e = r3(state.explode);
  if (state.section?.on) out.p = [state.section.axis, state.section.pct];
  if (state.overhang?.on) out.v = state.overhang.deg;
  if (state.thinWalls?.on) out.w = state.thinWalls.mm;
  return toBase64Url(JSON.stringify(out));
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const vec3 = (v: unknown): [number, number, number] | null =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1], v[2]] : null;

/** The state of a token, or null for anything that is not one of ours. Each field is checked
 *  on its own, so a damaged token still yields what it can. */
export function decodeViewerState(token: string | null | undefined): ViewerLinkState | null {
  if (!token) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(token));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const state: ViewerLinkState = {};
  if (o.t === 1 || o.t === 0) state.tab = o.t === 1 ? 'toolpath' : 'model';
  const dir = vec3(o.d);
  const target = vec3(o.c);
  const dist = num(o.r);
  if (dir && target && dist !== null && dist > 0) {
    const half = num(o.h);
    state.view = { dir, target, dist, ortho: o.o === 1 && half !== null && half > 0, half: half ?? 0 };
  }
  if (Array.isArray(o.l) && o.l.length === 2 && o.l.every((n) => Number.isInteger(n) && n >= 0)) state.layers = [o.l[0], o.l[1]];
  if (Array.isArray(o.f) && o.f.every((n) => Number.isInteger(n) && n >= 0 && n < 32)) state.hidden = o.f as number[];
  const style = num(o.s);
  if (style !== null && STYLES[style]) state.style = STYLES[style];
  if (o.x === 1) state.xray = true;
  const explode = num(o.e);
  if (explode !== null && explode > 0 && explode <= 1) state.explode = explode;
  if (Array.isArray(o.p) && (o.p[0] === 'x' || o.p[0] === 'y' || o.p[0] === 'z') && num(o.p[1]) !== null) state.section = { on: true, axis: o.p[0], pct: Math.min(100, Math.max(0, o.p[1] as number)) };
  const deg = num(o.v);
  if (deg !== null && deg > 0 && deg < 90) state.overhang = { on: true, deg };
  const mm = num(o.w);
  if (mm !== null && mm > 0 && mm < 10) state.thinWalls = { on: true, mm };
  return state;
}

// ---------- the user's display preferences (persist per browser) ----------

/** How the part is rendered (the Display menu's Rendering section). */
export interface RenderPrefs {
  shadows: boolean;
  /** Screen-space ambient occlusion (GTAO) through a post-processing pass. */
  ao: boolean;
  finish: 'matte' | 'satin' | 'glossy';
  reflections: 'off' | 'soft' | 'strong';
  background: 'dark' | 'light';
}

export interface DisplayPrefs {
  style: VisualStyle;
  grid: boolean;
  ortho: boolean;
  overhang: { on: boolean; deg: number };
  thinWalls: { on: boolean; mm: number };
  render: RenderPrefs;
}

export const FINISHES: RenderPrefs['finish'][] = ['matte', 'satin', 'glossy'];
export const REFLECTIONS: RenderPrefs['reflections'][] = ['off', 'soft', 'strong'];
export const BACKGROUNDS: RenderPrefs['background'][] = ['dark', 'light'];

export const DISPLAY_PREFS_KEY = 'fenrir.partViewer.display';
export const DEFAULT_RENDER_PREFS: RenderPrefs = { shadows: true, ao: false, finish: 'satin', reflections: 'soft', background: 'dark' };
export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = { style: 'shaded', grid: true, ortho: false, overhang: { on: false, deg: 45 }, thinWalls: { on: false, mm: 0.8 }, render: DEFAULT_RENDER_PREFS };

/** The saved preferences, each field checked; the defaults where nothing (valid) is saved. */
export function readDisplayPrefs(): DisplayPrefs {
  let raw: unknown = null;
  try {
    const text = window.localStorage.getItem(DISPLAY_PREFS_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  const d = DEFAULT_DISPLAY_PREFS;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return d;
  const o = raw as Record<string, unknown>;
  const oh = (o.overhang ?? {}) as Record<string, unknown>;
  const tw = (o.thinWalls ?? {}) as Record<string, unknown>;
  const deg = num(oh.deg);
  const mm = num(tw.mm);
  const r = (o.render ?? {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
  const render: RenderPrefs = {
    shadows: typeof r.shadows === 'boolean' ? r.shadows : d.render.shadows,
    ao: r.ao === true,
    finish: pick(r.finish, FINISHES, d.render.finish),
    reflections: pick(r.reflections, REFLECTIONS, d.render.reflections),
    background: pick(r.background, BACKGROUNDS, d.render.background),
  };
  return {
    render,
    style: typeof o.style === 'string' && STYLES.includes(o.style as VisualStyle) ? (o.style as VisualStyle) : d.style,
    grid: typeof o.grid === 'boolean' ? o.grid : d.grid,
    ortho: typeof o.ortho === 'boolean' ? o.ortho : d.ortho,
    overhang: { on: oh.on === true, deg: deg !== null && deg > 0 && deg < 90 ? deg : d.overhang.deg },
    thinWalls: { on: tw.on === true, mm: mm !== null && mm > 0 && mm < 10 ? mm : d.thinWalls.mm },
  };
}

export function writeDisplayPrefs(prefs: DisplayPrefs) {
  try {
    window.localStorage.setItem(DISPLAY_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or blocked storage: the settings simply do not persist.
  }
}

