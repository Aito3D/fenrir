export type TaxMode = "ht" | "ttc";
export type RevenueGranularity = "day" | "week" | "month" | "year";
export type RangePresetId = "this-year" | "last-12-months" | "all";
export type RevenueKind = "goods" | "services";
export type CustomerSegment = "pro" | "particulier" | "passage" | "inconnu";
export type ScopeReason = "decision-include" | "nature" | "brand" | "decision-exclude" | "unclassified" | "unknown-item";

export interface Money {
  ht: number;
  ttc: number;
}

export interface RevenueBucket {
  key: string;
  label: string;
  start: string;
  end: string;
  ht: number;
  ttc: number;
  goods: number;
  services: number;
  byNature: Record<string, number>;
  byBrand: Record<string, number>;
  byItem?: Record<string, number>;
  goodsTtc: number;
  servicesTtc: number;
  byNatureTtc: Record<string, number>;
  byBrandTtc: Record<string, number>;
  byItemTtc?: Record<string, number>;
  /** Stripped by the server for users without the customers permission. */
  bySegment?: Record<string, number>;
  bySegmentTtc?: Record<string, number>;
  /** Stripped by the server for users without the margin permission. */
  cost?: number;
  costedHt?: number;
  /** Gross margin HT per key, services' print + labour costs shared pro rata of their HT; same stripping as cost. */
  marginSplit?: { nature: Record<string, number>; brand: Record<string, number>; segment?: Record<string, number>; kind: Record<string, number> };
  /** What `cost` is made of: Zoho item costs (`items`), then the services' filament, energy, wear and labour. */
  costParts?: Partial<Record<'items' | 'filament' | 'energy' | 'wear' | 'labor', number>>;
  /** Printer hours of the print log in the bucket (null before the log began); stripped with the margin figures. */
  printHours?: number | null;
  projection: Money | null;
  projectionMethod: "seasonal" | "linear" | null;
  target?: number | null;
  quantity: number;
  evolution: { ht: number | null; ttc: number | null };
  yearAgo: Money | null;
  elapsedDays: number | null;
  cumulative: Money;
  partial: boolean;
  missingDays: number;
  ttcApprox: boolean;
}

export interface RevenueItemRow {
  itemId: string;
  name: string;
  sku: string;
  quantity: number;
  ht: number;
  ttc: number;
  /** Absent without the margin permission; null when the item has no cost. */
  cost?: number | null;
  nature: string | null;
  brand: string | null;
  kind: "goods" | "service";
  reason: ScopeReason;
}

export interface RevenueSyncStatus {
  running: boolean;
  fetchedDays: number;
  totalDays: number;
  missingDays: number;
  backfilling: boolean;
  legacyDays: number;
  lastBatchAt: string | null;
  lastError: string | null;
  /** Days whose own Zoho report keeps failing, newest first (at most 5); each waits out a growing back-off. */
  failedDays: RevenueFailedDay[];
  failedCount: number;
}

export interface RevenueFailedDay {
  day: string;
  attempts: number;
  nextRetryAt: string;
  error: string;
}

export interface RevenueItemSummary {
  itemId: string;
  name: string;
  sku: string;
  totalHt: number;
  quantity: number;
  lastDay: string;
}

export type RevenueProduct = RevenueItemSummary & {
  brand: string | null;
  kind?: "goods" | "service";
};

export type ReviewRow = RevenueItemSummary & { brand: string | null; nature: string | null };

export interface DecidedRow extends ReviewRow {
  included: boolean;
  decidedAt: string;
}

export interface SegmentRow {
  segment: CustomerSegment;
  ht: number;
  ttc: number;
  goods: number;
  services: number;
  goodsTtc: number;
  servicesTtc: number;
  customers: number;
}

export interface CustomerRow {
  customerId: string;
  name: string;
  segment: CustomerSegment;
  ht: number;
  ttc: number;
  goods: number;
  services: number;
  quantity: number;
  activeDays: number;
  lastDay: string;
}

export interface Acquisition {
  newCount: number;
  newHt: number;
  returningCount: number;
  returningHt: number;
  customerDays: number;
  avgBasketHt: number | null;
}

export interface CustomerBreakdown {
  segments: SegmentRow[];
  customers: CustomerRow[];
  customerCount: number;
  unsplitHt: number;
  acquisition: Acquisition | null;
}

export interface DayRange {
  from: string;
  to: string;
}

export interface Mover {
  key: string;
  label: string;
  current: number;
  previous: number;
  delta: number;
  change: number | null;
}

export interface MoversResult {
  current: DayRange;
  previous: DayRange;
  items: { up: Mover[]; down: Mover[] };
  brands: { up: Mover[]; down: Mover[] };
  totals: { current: number; previous: number };
}

export interface YoyYear {
  year: number;
  ht: (number | null)[];
  ttc: (number | null)[];
  cumulativeHt: (number | null)[];
  cumulativeTtc: (number | null)[];
}

export interface CalendarDay {
  day: string;
  ht: number;
  ttc: number;
  fetched: boolean;
}

export type AbcClass = "A" | "B" | "C";

export interface AbcRow extends RevenueItemRow {
  share: number;
  cumShare: number;
  cls: AbcClass;
}

export interface AbcResult {
  rows: AbcRow[];
  total: number;
  classes: Record<AbcClass, { count: number; ht: number }>;
}

export interface MarginRow {
  key: string;
  ht: number;
  costedHt: number;
  cost: number;
  margin: number;
  rate: number | null;
  coverage: number;
}

export interface DormantRow {
  itemId: string;
  name: string;
  sku: string;
  brand: string | null;
  ht: number;
  quantity: number;
  lastDay: string;
}

export interface RevenueTarget {
  month: string;
  amountHt: number;
  updatedAt: string;
}

export interface RevenueAnnotation {
  id: number;
  day: string;
  label: string;
}

export interface RevenueResponse {
  granularity: RevenueGranularity;
  from: string;
  to: string;
  items: string[] | null;
  brands: string[] | null;
  kind: string | null;
  segment: string | null;
  buckets: RevenueBucket[];
  sync: RevenueSyncStatus;
  reviewCount: number;
  itemsSyncedAt: string | null;
  fetchedAt: string;
}

export interface RevenueMonthCheck {
  month: string;
  zohoHt: number;
  cacheHt: number;
  gap: number;
  ok: boolean;
  checkedAt: string;
}

export interface ChecksResponse {
  checks: RevenueMonthCheck[];
}

export interface CashMonth {
  month: string;
  invoicedTtc: number;
  collected: number;
  collectedUnknown: number;
}

export interface CashResponse {
  months: CashMonth[];
  outstanding: { total: number; overdue: number; invoices: number; unknown: number };
  /** Absent without revenue:view_customers. */
  topOverdue?: Array<{ number: string; customerName: string; dueDate: string; daysOverdue: number; balance: number }>;
  coverage: { known: number; unknown: number };
  syncedAt: string | null;
  error: string | null;
}

export interface PipelineResponse {
  accepted: {
    count: number;
    total: number;
    retainerPaid: number;
    missingTotal: number;
    byColumn: Array<{ column: string; count: number; total: number }>;
  };
  awaiting: { count: number; total: number; oldestDays: number | null };
}

export interface ItemsResponse {
  items: RevenueItemRow[];
  from: string;
  to: string;
}

export interface ProductsResponse {
  products: RevenueProduct[];
  fetchedAt: string;
}

export interface ReviewResponse {
  unclassified: ReviewRow[];
  decided: DecidedRow[];
}

export interface SyncResponse {
  sync: RevenueSyncStatus;
}

/** The POST /sync result: the batch figures plus the fresh status. */
export interface SyncBatchResponse extends SyncResponse {
  fetched: number;
  pending: number;
  days: string[];
  customers: number;
}

export interface YoyResponse {
  years: YoyYear[];
  today: string;
}

export interface DailyResponse {
  from: string;
  to: string;
  days: CalendarDay[];
}

export interface TargetsResponse {
  targets: RevenueTarget[];
}

export interface AnnotationsResponse {
  annotations: RevenueAnnotation[];
}

/** One period of the page granularity: sales from first-time buyers of what the page shows, earlier buyers, and unidentified sales. */
export interface RetentionRow {
  key: string;
  label: string;
  start: string;
  end: string;
  newHt: number;
  returningHt: number;
  anonHt: number;
  newTtc: number;
  returningTtc: number;
  anonTtc: number;
  newCount: number;
  returningCount: number;
}

export interface CustomersResponse extends CustomerBreakdown {
  from: string;
  to: string;
  acquisition: Acquisition;
  retention: RetentionRow[];
}

export interface MoversResponse extends MoversResult {
  /** Null for a free comparison (cfrom/cto). */
  granularity: RevenueGranularity | null;
  key: string | null;
}

export interface AnalysisResponse {
  from: string;
  to: string;
  abc: AbcResult;
  /** Dropped by the server without the margin permission. */
  marginByBrand?: MarginRow[];
  marginByNature?: MarginRow[];
  dormant: DormantRow[];
}

export interface FixedCost {
  label: string;
  monthly: number;
}

export interface ResultMonth {
  month: string;
  ht: number;
  variable: number;
  labor: number;
  fixed: number;
  result: number;
}

export interface ResultResponse {
  fixedMonthly: number;
  months: ResultMonth[];
  /** Null when no contribution rate can be computed (no sales, costs above sales, or no charges). */
  breakEven: { amount: number; reached: number; day: string | null; projected: boolean } | null;
}
