import type { TFunction } from 'i18next';

/** `{label}: {message}` for a failure toast: the translated `key`, then the error's
 *  message, or nothing after `: ` when the thrown value is not an Error. */
export function failureMessage(t: TFunction, key: string, error: unknown): string {
  return `${t(key)}: ${error instanceof Error ? error.message : ''}`;
}
