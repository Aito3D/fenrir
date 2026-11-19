import { focusRingCls } from '../formStyles';

const DATE_INPUT = `rounded-md border bg-bambu-dark px-2 py-1 text-sm text-white ${focusRingCls}`;
// The error border of `inputErrorCls`, without its full-width form sizing.
export const dateInputCls = (bad: boolean) => `${DATE_INPUT} ${bad ? 'border-status-error/70' : 'border-bambu-dark-tertiary'}`;
