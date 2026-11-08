// One table for every `on_*` notification event flag. The add/edit modal (state, payload, toggles,
// ntfy/Gotify priority list) and the provider card (badges, quick toggles) all render from it, so an
// event's label, hint, default and colour are defined once. Per-surface order lives in the lists below.
// All strings are i18n keys.

export interface ModalFlag {
  default: boolean; // initial state for a new provider
  label: string; // toggle label, also the priority-row label
  desc?: string;
}

export interface CardFlag {
  label: string;
  desc?: string;
  default?: boolean; // fallback when the API omits the flag (undefined = no fallback)
}

interface BadgeFlag {
  label: string;
  cls: string; // colour classes only
}

interface EventFlagDef {
  modal?: ModalFlag;
  card?: CardFlag;
  badge?: BadgeFlag;
}

export const EVENT_FLAGS = {
  on_print_start: {
    modal: { default: false, label: 'notifications.start' },
    card: { label: 'notifications.printStarted' },
    badge: { label: 'notifications.start', cls: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400' },
  },
  on_plate_not_empty: {
    card: { label: 'notifications.plateNotEmpty', desc: 'notifications.plateNotEmptyDescription', default: true },
    badge: { label: 'notifications.plateCheck', cls: 'bg-rose-100 dark:bg-rose-600/20 text-rose-700 dark:text-rose-300' },
  },
  on_print_complete: {
    modal: { default: true, label: 'notifications.complete' },
    card: { label: 'notifications.printCompleted' },
    badge: { label: 'notifications.complete', cls: 'bg-bambu-green/20 text-bambu-green' },
  },
  on_plate_clear_required: {
    modal: { default: false, label: 'notifications.plateClearRequired', desc: 'notifications.plateClearRequiredDescription' },
    card: { label: 'notifications.plateClearRequired', desc: 'notifications.plateClearRequiredDescription', default: false },
    badge: { label: 'notifications.plateClear', cls: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400' },
  },
  // Post-print outcome confirmation (#1898). Defaults ON — it only fires for prints that opted in
  // per-job, so the toggle exists to mute a channel.
  on_print_confirm_request: {
    modal: { default: true, label: 'notifications.printConfirmRequest', desc: 'notifications.printConfirmRequestDescription' },
    card: { label: 'notifications.printConfirmRequest', desc: 'notifications.printConfirmRequestDescription', default: true },
    badge: { label: 'notifications.printConfirmRequest', cls: 'bg-teal-100 dark:bg-teal-500/20 text-teal-700 dark:text-teal-400' },
  },
  on_print_failed: {
    modal: { default: true, label: 'notifications.failed' },
    card: { label: 'notifications.printFailed' },
    badge: { label: 'notifications.failed', cls: 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-400' },
  },
  on_print_stopped: {
    modal: { default: true, label: 'notifications.stopped' },
    card: { label: 'notifications.printStopped' },
    badge: { label: 'notifications.stopped', cls: 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-400' },
  },
  on_billing_charge_failed: {
    modal: { default: true, label: 'notifications.billingChargeFailedLabel', desc: 'notifications.billingChargeFailedDescription' },
    card: { label: 'notifications.billingChargeFailedLabel', desc: 'notifications.billingChargeFailedDescription', default: true },
    badge: { label: 'notifications.billingChargeFailedLabel', cls: 'bg-red-100 dark:bg-red-600/20 text-red-700 dark:text-red-300' },
  },
  on_aito_payment_received: {
    card: { label: 'notifications.aitoPaymentReceivedLabel', desc: 'notifications.aitoPaymentReceivedDescription', default: false },
    badge: { label: 'notifications.aitoPaymentReceivedLabel', cls: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300' },
  },
  on_print_progress: {
    modal: { default: false, label: 'notifications.progress', desc: 'notifications.progressPercent' },
    card: { label: 'notifications.progressMilestones', desc: 'notifications.progressMilestonesDescription' },
    badge: { label: 'notifications.progress', cls: 'bg-yellow-100 dark:bg-yellow-500/20 text-yellow-700 dark:text-yellow-400' },
  },
  on_printer_offline: {
    modal: { default: false, label: 'notifications.offline' },
    card: { label: 'notifications.printerOffline' },
    badge: { label: 'notifications.offline', cls: 'bg-gray-500/20 text-gray-400' },
  },
  on_printer_error: {
    modal: { default: false, label: 'notifications.error' },
    card: { label: 'notifications.printerError' },
    badge: { label: 'notifications.error', cls: 'bg-rose-100 dark:bg-rose-500/20 text-rose-700 dark:text-rose-400' },
  },
  on_ai_failure_detection: {
    modal: { default: false, label: 'notifications.aiFailureDetection' },
    card: { label: 'notifications.aiFailureDetection', desc: 'notifications.aiFailureDetectionDescription', default: false },
    badge: { label: 'notifications.aiFailureDetection', cls: 'bg-fuchsia-100 dark:bg-fuchsia-500/20 text-fuchsia-700 dark:text-fuchsia-300' },
  },
  on_ha_sensor_alert: {
    modal: { default: false, label: 'notifications.haSensorAlert', desc: 'notifications.haSensorAlertDescription' },
    card: { label: 'notifications.haSensorAlert', desc: 'notifications.haSensorAlertDescription', default: false },
    badge: { label: 'notifications.haSensorAlert', cls: 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300' },
  },
  on_location_ha_sensor_alert: {
    modal: { default: false, label: 'notifications.locationHaSensorAlert', desc: 'notifications.locationHaSensorAlertDescription' },
    card: { label: 'notifications.locationHaSensorAlert', desc: 'notifications.locationHaSensorAlertDescription', default: false },
    badge: { label: 'notifications.locationHaSensorAlert', cls: 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300' },
  },
  on_filament_low: {
    modal: { default: false, label: 'notifications.lowFilament' },
    card: { label: 'notifications.lowFilamentLabel' },
    badge: { label: 'notifications.lowFilament', cls: 'bg-cyan-100 dark:bg-cyan-500/20 text-cyan-700 dark:text-cyan-400' },
  },
  on_maintenance_due: {
    modal: { default: false, label: 'notifications.maintenance' },
    card: { label: 'notifications.maintenanceDue', desc: 'notifications.maintenanceDueDescription', default: false },
    badge: { label: 'notifications.maintenance', cls: 'bg-purple-100 dark:bg-purple-500/20 text-purple-700 dark:text-purple-400' },
  },
  on_ams_humidity_high: {
    card: { label: 'notifications.amsHumidityHigh', desc: 'notifications.amsHumidityHighDescription', default: false },
    badge: { label: 'notifications.amsHumidity', cls: 'bg-blue-100 dark:bg-blue-600/20 text-blue-700 dark:text-blue-300' },
  },
  on_ams_temperature_high: {
    card: { label: 'notifications.amsTemperatureHigh', desc: 'notifications.amsTemperatureHighDescription', default: false },
    badge: { label: 'notifications.amsTemp', cls: 'bg-orange-100 dark:bg-orange-600/20 text-orange-700 dark:text-orange-300' },
  },
  on_ams_drying_suspended: {
    card: { label: 'notifications.amsDryingSuspendedTitle', desc: 'notifications.amsDryingSuspendedDescription', default: false },
    badge: { label: 'notifications.amsDryingSuspended', cls: 'bg-rose-100 dark:bg-rose-600/20 text-rose-700 dark:text-rose-300' },
  },
  on_ams_ht_humidity_high: {
    card: { label: 'notifications.amsHtHumidityHigh', desc: 'notifications.amsHtHumidityHighDescription', default: false },
    badge: { label: 'notifications.amsHtHumidity', cls: 'bg-cyan-100 dark:bg-cyan-600/20 text-cyan-700 dark:text-cyan-300' },
  },
  on_ams_ht_temperature_high: {
    card: { label: 'notifications.amsHtTemperatureHigh', desc: 'notifications.amsHtTemperatureHighDescription', default: false },
    badge: { label: 'notifications.amsHtTemp', cls: 'bg-amber-100 dark:bg-amber-600/20 text-amber-700 dark:text-amber-300' },
  },
  on_bed_cooled: {
    modal: { default: false, label: 'notifications.bedCooled', desc: 'notifications.bedCooledAfterPrint' },
    card: { label: 'notifications.bedCooledLabel', desc: 'notifications.bedCooledDescription', default: false },
    badge: { label: 'notifications.bedCooled', cls: 'bg-teal-100 dark:bg-teal-500/20 text-teal-700 dark:text-teal-400' },
  },
  on_first_layer_complete: {
    modal: { default: false, label: 'notifications.firstLayerCompleteLabel', desc: 'notifications.firstLayerCompleteDescription' },
    card: { label: 'notifications.firstLayerCompleteLabel', desc: 'notifications.firstLayerCompleteDescription', default: false },
    badge: { label: 'notifications.firstLayer', cls: 'bg-emerald-100 dark:bg-emerald-600/20 text-emerald-700 dark:text-emerald-300' },
  },
  on_print_pause_upcoming: {
    modal: { default: false, label: 'notifications.pauseUpcomingLabel', desc: 'notifications.pauseUpcomingDescription' },
    card: { label: 'notifications.pauseUpcomingLabel', desc: 'notifications.pauseUpcomingDescription', default: false },
    badge: { label: 'notifications.pauseUpcomingBadge', cls: 'bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-400' },
  },
  on_app_message: {
    modal: { default: false, label: 'notifications.appMessages', desc: 'notifications.appMessagesDescription' },
    card: { label: 'notifications.appMessages', desc: 'notifications.appMessagesDescription', default: false },
    badge: { label: 'notifications.appMessagesBadge', cls: 'bg-sky-100 dark:bg-sky-500/20 text-sky-700 dark:text-sky-400' },
  },
  on_print_missing_spool_assignment: {
    card: { label: 'notifications.missingSpoolAssignmentLabel', desc: 'notifications.missingSpoolAssignmentDescription', default: false },
    badge: { label: 'notifications.missingSpoolAssignmentLabel', cls: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300' },
  },
  on_stock_reorder_alert: {
    modal: { default: false, label: 'notifications.stockReorderAlert', desc: 'notifications.stockReorderAlertDescription' },
    card: { label: 'notifications.stockReorderAlert', desc: 'notifications.stockReorderAlertDescription', default: false },
    badge: { label: 'notifications.stockReorderAlert', cls: 'bg-lime-100 dark:bg-lime-500/20 text-lime-700 dark:text-lime-400' },
  },
  on_stock_break_alert: {
    modal: { default: false, label: 'notifications.stockBreakAlert', desc: 'notifications.stockBreakAlertDescription' },
    card: { label: 'notifications.stockBreakAlert', desc: 'notifications.stockBreakAlertDescription', default: false },
    badge: { label: 'notifications.stockBreakAlert', cls: 'bg-red-100 dark:bg-red-600/20 text-red-700 dark:text-red-300' },
  },
  on_queue_job_added: {
    card: { label: 'notifications.jobAdded', desc: 'notifications.jobAddedDescription', default: false },
  },
  on_queue_job_assigned: {
    card: { label: 'notifications.jobAssigned', desc: 'notifications.jobAssignedDescription', default: false },
  },
  on_queue_job_started: {
    card: { label: 'notifications.jobStarted', desc: 'notifications.jobStartedDescription', default: false },
  },
  on_queue_job_waiting: {
    card: { label: 'notifications.jobWaiting', desc: 'notifications.jobWaitingDescription', default: true },
  },
  on_queue_job_skipped: {
    card: { label: 'notifications.jobSkipped', desc: 'notifications.jobSkippedDescription', default: true },
  },
  on_queue_job_failed: {
    card: { label: 'notifications.jobFailed', desc: 'notifications.jobFailedDescription', default: true },
  },
  on_queue_completed: {
    card: { label: 'notifications.queueComplete', desc: 'notifications.queueCompleteDescription', default: false },
  },
} as const satisfies Record<string, EventFlagDef>;

export type EventFlagKey = keyof typeof EVENT_FLAGS;
type KeysWith<P extends string> = {
  [K in EventFlagKey]: (typeof EVENT_FLAGS)[K] extends Record<P, unknown> ? K : never;
}[EventFlagKey];
export type ModalFlagKey = KeysWith<'modal'>;
export type BadgeFlagKey = KeysWith<'badge'>;

/** Modal toggle sections, in DOM order. `grid: null` renders the rows without a grid wrapper. */
export const MODAL_SECTIONS: { title: string; grid: string | null; keys: ModalFlagKey[] }[] = [
  {
    title: 'notifications.printEvents',
    grid: 'grid grid-cols-2 gap-2',
    keys: [
      'on_print_start', 'on_print_complete', 'on_print_failed', 'on_print_stopped', 'on_print_progress',
      'on_billing_charge_failed', 'on_plate_clear_required', 'on_print_confirm_request', 'on_bed_cooled',
      'on_first_layer_complete', 'on_print_pause_upcoming',
    ],
  },
  {
    title: 'notifications.printerStatus',
    grid: 'grid grid-cols-2 gap-2',
    keys: [
      'on_printer_offline', 'on_ha_sensor_alert', 'on_location_ha_sensor_alert', 'on_printer_error',
      'on_ai_failure_detection', 'on_filament_low', 'on_maintenance_due',
    ],
  },
  { title: 'notifications.inventoryAlerts', grid: 'grid grid-cols-1 gap-2', keys: ['on_stock_reorder_alert', 'on_stock_break_alert'] },
  // Messages other applications send (POST /notifications/app-message)
  { title: 'notifications.connectedApps', grid: null, keys: ['on_app_message'] },
];

/** ntfy (#990) / Gotify (#2743) priority rows, in DOM order. The card lists no priorities. */
export const MODAL_PRIORITY_KEYS: ModalFlagKey[] = [
  'on_print_start', 'on_print_complete', 'on_print_failed', 'on_print_stopped', 'on_print_progress',
  'on_billing_charge_failed', 'on_plate_clear_required', 'on_print_confirm_request', 'on_bed_cooled',
  'on_first_layer_complete', 'on_print_pause_upcoming', 'on_printer_offline', 'on_printer_error',
  'on_ha_sensor_alert', 'on_location_ha_sensor_alert', 'on_ai_failure_detection', 'on_filament_low',
  'on_maintenance_due', 'on_stock_reorder_alert', 'on_stock_break_alert',
];

/** Card badges in DOM order, split around the Telegram verdict badges that sit between them. */
export const CARD_BADGES_BEFORE_VERDICT: BadgeFlagKey[] = [
  'on_print_start', 'on_plate_not_empty', 'on_print_complete', 'on_plate_clear_required', 'on_print_confirm_request',
];
export const CARD_BADGES_AFTER_VERDICT: BadgeFlagKey[] = [
  'on_print_failed', 'on_print_stopped', 'on_billing_charge_failed', 'on_aito_payment_received', 'on_print_progress',
  'on_printer_offline', 'on_printer_error', 'on_ai_failure_detection', 'on_ha_sensor_alert',
  'on_location_ha_sensor_alert', 'on_filament_low', 'on_maintenance_due', 'on_ams_humidity_high',
  'on_ams_temperature_high', 'on_ams_drying_suspended', 'on_ams_ht_humidity_high', 'on_ams_ht_temperature_high',
  'on_bed_cooled', 'on_first_layer_complete', 'on_print_pause_upcoming', 'on_app_message',
  'on_print_missing_spool_assignment', 'on_stock_reorder_alert', 'on_stock_break_alert',
];

/** Card quick-toggle sections, in DOM order. */
export const CARD_SECTIONS: { title: string; keys: EventFlagKey[] }[] = [
  {
    title: 'notifications.printEvents',
    keys: [
      'on_print_start', 'on_plate_not_empty', 'on_print_complete', 'on_plate_clear_required',
      'on_print_confirm_request', 'on_bed_cooled', 'on_first_layer_complete', 'on_print_pause_upcoming',
      'on_print_missing_spool_assignment', 'on_aito_payment_received', 'on_print_failed', 'on_print_stopped',
      'on_billing_charge_failed', 'on_print_progress',
    ],
  },
  {
    title: 'notifications.printerStatus',
    keys: [
      'on_printer_offline', 'on_printer_error', 'on_ai_failure_detection', 'on_ha_sensor_alert',
      'on_location_ha_sensor_alert', 'on_filament_low', 'on_maintenance_due',
    ],
  },
  { title: 'notifications.amsAlarms', keys: ['on_ams_humidity_high', 'on_ams_temperature_high', 'on_ams_drying_suspended'] },
  { title: 'notifications.amsHtAlarms', keys: ['on_ams_ht_humidity_high', 'on_ams_ht_temperature_high'] },
  { title: 'notifications.inventoryAlerts', keys: ['on_stock_reorder_alert', 'on_stock_break_alert'] },
  {
    title: 'notifications.printQueue',
    keys: [
      'on_queue_job_added', 'on_queue_job_assigned', 'on_queue_job_started', 'on_queue_job_waiting',
      'on_queue_job_skipped', 'on_queue_job_failed', 'on_queue_completed', 'on_app_message',
    ],
  },
];
