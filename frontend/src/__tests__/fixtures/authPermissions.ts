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
 */
type AuthModule = { useAuth: () => { hasPermission: (p: string) => boolean } };

export function withGrantedPermissions<M extends AuthModule>(actual: M, getGranted: () => Set<string> | null): M {
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      const granted = getGranted();
      return granted ? { ...real, hasPermission: (p: string) => granted.has(p) } : real;
    },
  };
}
