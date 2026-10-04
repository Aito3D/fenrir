import { parseUTCDate } from './date';
import type { AitoProject } from '../api/client';
import { alnum, digits, fold, foldWithMap, numericTail, phoneDigits, stripZeros, withinOneEdit } from './aitoSearchNormalize';

export type MatchKind = 'phone' | 'email' | 'number' | 'name' | 'text' | 'task';
export type SearchField =
  | 'clientPhone' | 'shippingPhone' | 'email' | 'quote' | 'document' | 'lta' | 'cardId'
  | 'client' | 'contact' | 'recipient' | 'social' | 'salesperson' | 'description' | 'task';
export type SearchLocation = 'board' | 'done' | 'trash';
export interface Excerpt {
  before: string;
  match: string;
  after: string;
}
export interface SearchHit {
  project: AitoProject;
  score: number;
  kind: MatchKind;
  field: SearchField;
  excerpt: Excerpt;
  location: SearchLocation;
}

/** Per-term scores. The tiers are the spec's: an exact identifier beats a
 *  name, a name beats the description, the description beats task notes, and
 *  a one-typo name comes last. A card's score is the sum over its terms. */
const SCORE = {
  exact: 100,
  phoneSuffix: 70,
  namePrefix: 60,
  email: 55,
  descriptionWord: 50,
  numberPartial: 45,
  phonePartial: 40,
  nameSubstring: 30,
  descriptionSubstring: 30,
  taskWord: 25,
  taskSubstring: 15,
  fuzzy: 10,
} as const;

const EXCERPT_CONTEXT = 20;
const MIN_PHONE_DIGITS = 4;
const MIN_FUZZY_LENGTH = 4;
const LOCATION_ORDER: Record<SearchLocation, number> = { board: 0, done: 1, trash: 2 };

interface IndexedField {
  kind: MatchKind;
  field: SearchField;
  raw: string;
  folded: string;
  map: number[];
  /** phoneDigits for phones, alnum for numbers, '' otherwise. */
  key: string;
  words: { text: string; start: number }[];
}

interface Term {
  text: string;
  allow: (field: IndexedField) => boolean;
}

interface Match {
  score: number;
  start: number;
  end: number;
  whole: boolean;
}

const index = new WeakMap<AitoProject, IndexedField[]>();

function wordsOf(folded: string): { text: string; start: number }[] {
  const words: { text: string; start: number }[] = [];
  for (const m of folded.matchAll(/[a-z0-9]+/g)) words.push({ text: m[0], start: m.index ?? 0 });
  return words;
}

function indexed(project: AitoProject): IndexedField[] {
  const cached = index.get(project);
  if (cached) return cached;
  const recipient = [project.shipping_first_name, project.shipping_last_name].filter(Boolean).join(' ');
  const entries: [MatchKind, SearchField, string | null | undefined][] = [
    ['phone', 'clientPhone', project.client_phone],
    ['phone', 'shippingPhone', project.shipping_phone],
    ['email', 'email', project.client_email],
    ['number', 'quote', project.quote_number],
    ...(project.document_numbers ?? []).map((n): [MatchKind, SearchField, string] => ['number', 'document', n]),
    ['number', 'lta', project.shipping_lta],
    ['number', 'cardId', String(project.id)],
    ['name', 'client', project.client_name],
    ['name', 'contact', project.client_contact_name],
    ['name', 'recipient', recipient],
    ['name', 'social', project.client_social_handle],
    ['name', 'salesperson', project.quote_salesperson],
    ['text', 'description', project.description],
    ['task', 'task', project.search_text],
  ];
  const fields = entries
    .filter((entry): entry is [MatchKind, SearchField, string] => typeof entry[2] === 'string' && entry[2].trim() !== '')
    .map(([kind, field, raw]) => {
      const { text, map } = foldWithMap(raw);
      const key = kind === 'phone' ? phoneDigits(raw) : kind === 'number' ? alnum(raw) : '';
      return { kind, field, raw, folded: text, map, key, words: kind === 'name' ? wordsOf(text) : [] };
    });
  index.set(project, fields);
  return fields;
}

const PREFIXES: { prefix: string; keep: boolean; allow: (f: IndexedField) => boolean }[] = [
  { prefix: 'tel:', keep: false, allow: (f) => f.kind === 'phone' },
  { prefix: 'mail:', keep: false, allow: (f) => f.kind === 'email' },
  { prefix: 'inv:', keep: false, allow: (f) => f.field === 'document' },
  { prefix: 'lta:', keep: false, allow: (f) => f.field === 'lta' },
  { prefix: '@', keep: true, allow: (f) => f.kind === 'email' || f.field === 'social' },
  { prefix: '#', keep: false, allow: (f) => f.kind === 'number' },
];
const DEFAULT_ALLOW = (f: IndexedField) => f.field !== 'cardId';

const PHONE_SHAPED = /^\+?[\d.\-()]+$/;

let lastQuery: string | null = null;
let lastTerms: Term[] = [];

/** Fold, split, and glue runs of digit-only tokens back together, so a phone
 *  read out in pairs (`87 12 34 56`) is one term. */
function parse(query: string): Term[] {
  if (query === lastQuery) return lastTerms;
  const tokens: string[] = [];
  let lastPiece = 0;
  for (const token of fold(query).split(/\s+/).filter(Boolean)) {
    const numeric = PHONE_SHAPED.test(token);
    const piece = digits(token).length;
    const previous = tokens[tokens.length - 1];
    // Only short groups glue (`87 12 34 56`, `+689 87 12`): two 4-digit
    // numbers (`2638 1200`) are separate identifiers, not one phone.
    const glue =
      numeric && previous !== undefined && PHONE_SHAPED.test(previous) && (previous.startsWith('+') || (piece <= 3 && lastPiece <= 3));
    if (glue) tokens[tokens.length - 1] = previous + token;
    else tokens.push(token);
    lastPiece = piece;
  }
  lastTerms = tokens.map((token) => {
    for (const { prefix, keep, allow } of PREFIXES) {
      if (token.startsWith(prefix) && token.length > prefix.length) {
        return { text: keep ? token : token.slice(prefix.length), allow };
      }
    }
    return { text: token, allow: DEFAULT_ALLOW };
  });
  lastQuery = query;
  return lastTerms;
}

function substring(field: IndexedField, term: string, word: number, sub: number): Match | null {
  const at = field.folded.indexOf(term);
  if (at < 0) return null;
  const wordStart = at === 0 || !/[a-z0-9]/.test(field.folded[at - 1]);
  return { score: wordStart ? word : sub, start: at, end: at + term.length, whole: false };
}

function matchField(field: IndexedField, term: string): Match | null {
  const whole = (score: number): Match => ({ score, start: 0, end: field.folded.length, whole: true });
  switch (field.kind) {
    case 'phone': {
      if (!PHONE_SHAPED.test(term)) return null;
      const typed = phoneDigits(term);
      if (digits(term).length < MIN_PHONE_DIGITS || typed.length < MIN_PHONE_DIGITS) return null;
      if (field.key === typed) return whole(SCORE.exact);
      if (field.key.endsWith(typed)) return whole(SCORE.phoneSuffix);
      return field.key.includes(typed) ? whole(SCORE.phonePartial) : null;
    }
    case 'email': {
      if (field.folded === term) return whole(SCORE.exact);
      const at = field.folded.indexOf(term);
      return at < 0 ? null : { score: SCORE.email, start: at, end: at + term.length, whole: false };
    }
    case 'number': {
      const typed = alnum(term);
      if (typed === '') return null;
      if (field.field === 'cardId') return digits(typed) === typed && stripZeros(typed) === field.raw ? whole(SCORE.exact) : null;
      const parts = /^([a-z]*)(\d+)$/.exec(typed);
      if (typed === field.key || (parts && stripZeros(parts[2]) === numericTail(field.raw) && field.key.startsWith(parts[1]))) {
        return whole(SCORE.exact);
      }
      return field.key.includes(typed) ? whole(SCORE.numberPartial) : null;
    }
    case 'name': {
      const prefix = field.words.find((w) => w.text.startsWith(term));
      if (prefix) return { score: SCORE.namePrefix, start: prefix.start, end: prefix.start + term.length, whole: false };
      const sub = substring(field, term, SCORE.nameSubstring, SCORE.nameSubstring);
      if (sub) return sub;
      if (term.length < MIN_FUZZY_LENGTH) return null;
      const near = field.words.find((w) => w.text.length >= MIN_FUZZY_LENGTH - 1 && withinOneEdit(term, w.text));
      return near ? { score: SCORE.fuzzy, start: near.start, end: near.start + near.text.length, whole: false } : null;
    }
    case 'text':
      return substring(field, term, SCORE.descriptionWord, SCORE.descriptionSubstring);
    case 'task':
      return substring(field, term, SCORE.taskWord, SCORE.taskSubstring);
  }
}

function excerptOf(field: IndexedField, match: Match): Excerpt {
  if (match.whole) return { before: '', match: field.raw, after: '' };
  const start = field.map[match.start];
  const lastChar = field.map[match.end - 1];
  const end = lastChar + String.fromCodePoint(field.raw.codePointAt(lastChar)!).length;
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const from = Math.max(0, start - EXCERPT_CONTEXT);
  const to = Math.min(field.raw.length, end + EXCERPT_CONTEXT);
  return {
    before: (from > 0 ? '…' : '') + flat(field.raw.slice(from, start)),
    match: field.raw.slice(start, end),
    after: flat(field.raw.slice(end, to)) + (to < field.raw.length ? '…' : ''),
  };
}

export function locationOf(project: AitoProject): SearchLocation {
  if (project.status === 'deleted') return 'trash';
  return project.column === 'done' ? 'done' : 'board';
}

function score(project: AitoProject, terms: Term[]): SearchHit | null {
  const fields = indexed(project);
  let total = 0;
  let best: { field: IndexedField; match: Match } | null = null;
  for (const term of terms) {
    let termBest: { field: IndexedField; match: Match } | null = null;
    for (const field of fields) {
      if (!term.allow(field)) continue;
      const match = matchField(field, term.text);
      if (match && (!termBest || match.score > termBest.match.score)) termBest = { field, match };
    }
    if (!termBest) return null;
    total += termBest.match.score;
    if (!best || termBest.match.score > best.match.score) best = termBest;
  }
  if (!best) return null;
  return {
    project,
    score: total,
    kind: best.field.kind,
    field: best.field.field,
    excerpt: excerptOf(best.field, best.match),
    location: locationOf(project),
  };
}

/** Every matching card, best first. Ties: board, then Done, then Trash, then
 *  most recently updated, then highest id — stable across refetches. */
export function searchProjects(projects: AitoProject[], query: string): SearchHit[] {
  const terms = parse(query);
  if (terms.length === 0) return [];
  const time = (p: AitoProject) => parseUTCDate(p.updated_at)?.getTime() ?? 0;
  return projects
    .map((p) => score(p, terms))
    .filter((hit): hit is SearchHit => hit !== null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        LOCATION_ORDER[a.location] - LOCATION_ORDER[b.location] ||
        time(b.project) - time(a.project) ||
        b.project.id - a.project.id,
    );
}

/** The board filter. Same scoring as `searchProjects`, so the board and the
 *  dropdown can never disagree; an empty query matches everything. */
export function matchesSearch(project: AitoProject, query: string): boolean {
  const terms = parse(query);
  return terms.length === 0 || score(project, terms) !== null;
}

/** Search-filtered projects, most recently updated first — the shared body
 *  behind both archive grids (Done, Trash). Neither is the board: both are
 *  flat, ever-growing lists where the stored `position`/column order is
 *  meaningless (drop-order history for Done, arbitrary for Trash), so both
 *  reorder by `updated_at` instead. */
export function sortByRecencyDesc(projects: AitoProject[], query: string): AitoProject[] {
  // `parseUTCDate`, not a string compare: the board's timestamps are
  // inconsistently suffixed ('…:00Z' on some rows, '…:00' on others) and a
  // lexical compare orders those two forms by their suffix, not their
  // instant. Ties break on id descending so the order is stable.
  const time = (project: AitoProject) => parseUTCDate(project.updated_at)?.getTime() ?? 0;
  return projects
    .filter((project) => matchesSearch(project, query))
    .slice()
    .sort((a, b) => time(b) - time(a) || b.id - a.id);
}
