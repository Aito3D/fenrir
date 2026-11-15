/** Message of a thrown value: ApiError and Error carry it, anything else is stringified. */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
