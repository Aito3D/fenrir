/** DOM ids pairing a tab with its panel (`aria-controls` / `aria-labelledby`).
 *
 *  Their own module rather than exports off PanelTabs.tsx: that file exports
 *  a component, and the react-refresh rule refuses to let a module export
 *  both — a helper changing would blow away the component's state on every
 *  hot reload. */
export const panelTabId = (id: string) => `panel-tab-${id}`;
export const panelTabPanelId = (id: string) => `panel-tabpanel-${id}`;
