/** DOM ids pairing a tab with its panel (`aria-controls` / `aria-labelledby`).
 *
 *  Their own module rather than exports off PanelTabs.tsx: that file exports
 *  a component, and the react-refresh rule refuses to let a module export
 *  both — a helper changing would blow away the component's state on every
 *  hot reload. */
// `scope` keeps ids unique when several panels are open at once (the order board).
export const panelTabId = (id: string, scope = '') => `panel-tab-${scope}${id}`;
export const panelTabPanelId = (id: string, scope = '') => `panel-tabpanel-${scope}${id}`;
