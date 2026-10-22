/**
 * Shared body of the partial `AuthContext` mock used by the project tests.
 *
 * `vi.mock` is hoisted above imports, so each test file keeps its own call and
 * loads this helper lazily inside the factory:
 *
 *   let granted: Set<string> | null = null;
 *   vi.mock('<path>/contexts/AuthContext', async (importOriginal) => {
 *     const { withGrantedPermissions } = await import('<path>/__tests__/fixtures/authPermissions');
 *     return withGrantedPermissions(await importOriginal<typeof import('<path>/contexts/AuthContext')>(), () => granted);
 *   });
 *
 * A null set keeps the real provider's behaviour (auth disabled: everything granted).
 *
 * Pass `{ derived: true }` to also derive `hasAnyPermission` and `canModify`
 * (`<resource>:<action>_all|_own`) from the granted set; by default only
 * `hasPermission` is replaced and the real provider answers the rest.
 */
type AuthModule = { useAuth: () => { hasPermission: (p: string) => boolean } };

export function withGrantedPermissions<M extends AuthModule>(
  actual: M,
  getGranted: () => Set<string> | null,
  options: { derived?: boolean } = {},
): M {
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      const granted = getGranted();
      if (!granted) return real;
      const mocked = { ...real, hasPermission: (p: string) => granted.has(p) };
      if (!options.derived) return mocked;
      return {
        ...mocked,
        hasAnyPermission: (...ps: string[]) => ps.some((p) => granted.has(p)),
        canModify: (resource: string, action: string) =>
          granted.has(`${resource}:${action}_all`) || granted.has(`${resource}:${action}_own`),
      };
    },
  };
}
