import { useTranslation } from 'react-i18next';

export interface FieldErrorProps {
  /** An i18n key from the pure validators, or null when the field is fine. */
  messageKey: string | null;
}

/** One line of inline validation feedback under a form field. Renders nothing
 *  when there is no error, so callers can drop it in unconditionally. */
export function FieldError({ messageKey }: FieldErrorProps) {
  const { t } = useTranslation();
  if (!messageKey) return null;
  return (
    // animate-rise: an error only ever appears in reaction to leaving a field
    // or asking to create, and the small rise is what ties the message to that
    // action instead of it popping in somewhere in a 1100px drawer.
    <p role="alert" className="animate-rise mt-1 text-xs text-status-error">
      {t(messageKey)}
    </p>
  );
}
