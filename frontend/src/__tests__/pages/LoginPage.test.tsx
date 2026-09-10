/**
 * Tests for the LoginPage component.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils';
import { LoginPage } from '../../pages/LoginPage';
import { setAuthToken } from '../../api/client';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';

// Spy on navigation so we can assert the #1889 redirect-away-if-authenticated
// guard. importActual keeps BrowserRouter / useLocation / useSearchParams real.
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

describe('LoginPage', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/v1/auth/status', () => {
        return HttpResponse.json({ auth_enabled: true, requires_setup: false });
      })
    );
  });

  describe('rendering', () => {
    it('renders the login form', async () => {
      render(<LoginPage />);

      await waitFor(() => {
        // The credentials step is identified by the brand logo — it has no heading.
        expect(screen.getByAltText('AITO3D')).toBeInTheDocument();
      });

      expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/Password/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Sign in/i })).toBeInTheDocument();
    });

    it('renders the sign in description', async () => {
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByText(/Sign in to your account/i)).toBeInTheDocument();
      });
    });
  });

  describe('form validation', () => {
    it('shows error when submitting empty form', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Sign in/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('button', { name: /Sign in/i }));

      // The form has required fields, so HTML5 validation should prevent submission
      // or the component shows a toast
    });

    it('allows entering username and password', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/Username/i), 'testuser');
      await user.type(screen.getByLabelText(/Password/i), 'testpassword');

      expect(screen.getByLabelText(/Username/i)).toHaveValue('testuser');
      expect(screen.getByLabelText(/Password/i)).toHaveValue('testpassword');
    });
  });

  describe('login flow', () => {
    // T-055: the successful-login tests below drive exitToDashboard(), which
    // (per LoginPage.tsx) either navigates synchronously under reduced motion
    // or, by default, schedules a raw `window.setTimeout(..., 700)` that is
    // never cleared on unmount. Left alone, that real timer survives into
    // later tests in this file and can call mockNavigate mid-test, corrupting
    // an unrelated assertion (see the T-038 test below and its own comment).
    // Force reduced motion here — same mechanism the T-037 block below uses —
    // so exitToDashboard() always takes the synchronous branch and leaves no
    // pending timer to leak.
    let originalMatchMedia: typeof window.matchMedia;

    beforeEach(() => {
      originalMatchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      })) as typeof window.matchMedia;
    });

    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    it('submits login request with credentials', async () => {
      const user = userEvent.setup();
      let loginCalled = false;

      server.use(
        http.post('/api/v1/auth/login', async ({ request }) => {
          loginCalled = true;
          const body = await request.json() as { username: string; password: string };
          if (body.username === 'validuser' && body.password === 'validpass') {
            return HttpResponse.json({
              access_token: 'test-token',
              token_type: 'bearer',
              user: {
                id: 1,
                username: 'validuser',
                role: 'admin',
                is_active: true,
                created_at: new Date().toISOString(),
              },
            });
          }
          return HttpResponse.json(
            { detail: 'Incorrect username or password' },
            { status: 401 }
          );
        })
      );

      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/Username/i), 'validuser');
      await user.type(screen.getByLabelText(/Password/i), 'validpass');
      await user.click(screen.getByRole('button', { name: /Sign in/i }));

      // Verify the login endpoint was called
      await waitFor(() => {
        expect(loginCalled).toBe(true);
      });
    });

    it('shows loading state during login', async () => {
      const user = userEvent.setup();
      let resolveLogin: () => void;
      const loginPromise = new Promise<void>(resolve => { resolveLogin = resolve; });

      // Slow login endpoint that we control
      server.use(
        http.post('/api/v1/auth/login', async () => {
          await loginPromise;
          return HttpResponse.json({
            access_token: 'test-token',
            token_type: 'bearer',
            user: {
              id: 1,
              username: 'testuser',
              role: 'admin',
              is_active: true,
              created_at: new Date().toISOString(),
            },
          });
        })
      );

      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/Username/i), 'testuser');
      await user.type(screen.getByLabelText(/Password/i), 'testpass');
      await user.click(screen.getByRole('button', { name: /Sign in/i }));

      // Check for loading state - button text should change to "Logging in..."
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Logging in/i })).toBeInTheDocument();
      });

      // Release the login request
      resolveLogin!();
    });

    // T-055 regression guard: without the reduced-motion hardening above, the
    // previous two tests' successful logins would each leave a raw, uncleared
    // 700ms window.setTimeout pending (see LoginPage.tsx's exitToDashboard),
    // which fires during whichever later test happens to still be running and
    // pollutes mockNavigate's call list (confirmed: this exact test fails if
    // the beforeEach/afterEach above is removed). Waiting out that window here
    // and asserting no stray navigate call proves nothing leaked across the
    // test boundary. The 800ms real-time wait is deliberate and bounded — it
    // mirrors the hazard's own timer plus margin, not a general sleep.
    it('does not leak a navigate() call from an earlier successful login', async () => {
      // Let the previous test's own render settle first: a successful login's
      // checkAuthStatus() round-trip can still be resolving a follow-up
      // render (the unrelated #1889 "already authenticated" effect) a few ms
      // after the test function itself returned — that's expected, near-
      // instant, and not the hazard T-055 is guarding against. Clear it out
      // before arming the real check.
      await new Promise(r => setTimeout(r, 50));
      mockNavigate.mockClear();
      // Now wait out (with margin) LoginPage's own 700ms exitToDashboard
      // delay. If the reduced-motion hardening above weren't applied, the
      // previous tests' successful logins would each leave a raw, uncleared
      // window.setTimeout(..., 700) pending, which would fire in here and
      // call navigate() again — this is the actual T-055 regression this
      // test guards against (confirmed: fails without the hardening above).
      await new Promise(r => setTimeout(r, 800));
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    // T-038: loginMutation.onError (LoginPage.tsx `showToast(error.message ||
    // t('login.loginFailed'), 'error')`) had no test hitting the 401 branch of
    // the mock handler above — wire it up with mismatched credentials.
    it('shows an error toast with the backend detail on invalid credentials and does not navigate away', async () => {
      const user = userEvent.setup();
      mockNavigate.mockClear();
      // A prior test in this file (e.g. the successful "shows loading state"
      // login) can leave a session token behind, which would otherwise trip
      // the #1889 already-authenticated redirect before we even submit.
      setAuthToken(null);
      sessionStorage.clear();

      server.use(
        http.post('/api/v1/auth/login', () =>
          HttpResponse.json(
            { detail: 'Incorrect username or password' },
            { status: 401 }
          )
        )
      );

      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/Username/i), 'wronguser');
      await user.type(screen.getByLabelText(/Password/i), 'wrongpass');
      await user.click(screen.getByRole('button', { name: /Sign in/i }));

      // Positive evidence first: the 401's `detail` string surfaces verbatim
      // as the error toast (client.ts passes it through as error.message).
      await waitFor(() => {
        expect(screen.getByText('Incorrect username or password')).toBeInTheDocument();
      });

      // Only now check the negative: a failed login must never navigate
      // anywhere, and the credentials form must still be on screen.
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
    });

    it('falls back to the generic login-failed message when the error has no detail text', async () => {
      const user = userEvent.setup();
      setAuthToken(null);
      sessionStorage.clear();

      server.use(
        // An empty-string `detail` is the one shape client.ts's request()
        // turns into a falsy error.message, exercising the `|| t('login.loginFailed')`
        // fallback in onError rather than the plain 401 detail branch above.
        http.post('/api/v1/auth/login', () =>
          HttpResponse.json({ detail: '' }, { status: 401 })
        )
      );

      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/Username/i), 'someuser');
      await user.type(screen.getByLabelText(/Password/i), 'somepass');
      await user.click(screen.getByRole('button', { name: /Sign in/i }));

      await waitFor(() => {
        expect(screen.getByText('Login failed')).toBeInTheDocument();
      });
    });
  });

  // T-061: exitToDashboard()'s `window.setTimeout(() => navigate(...), 700)`
  // used to store no id, so LoginPage registered no cleanup and a pending
  // exit-navigate could still fire after the component unmounted. This block
  // deliberately runs OUTSIDE the "login flow" describe above (which forces
  // reduced motion in its own beforeEach) so the real, un-reduced 700ms timer
  // arms — setup.ts's global window.matchMedia mock already defaults to
  // `matches: false`, so no override is needed here.
  describe('exit-timer cleanup on unmount (T-061)', () => {
    it('does not navigate after unmount once the 700ms exit timer would have fired', async () => {
      const user = userEvent.setup();
      setAuthToken(null);
      sessionStorage.clear();
      mockNavigate.mockClear();

      server.use(
        http.post('/api/v1/auth/login', () =>
          HttpResponse.json({
            access_token: 'test-token',
            token_type: 'bearer',
            user: {
              id: 1,
              username: 'validuser',
              role: 'admin',
              is_active: true,
              created_at: new Date().toISOString(),
            },
          })
        )
      );

      const { unmount, container } = render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/Username/i), 'validuser');
      await user.type(screen.getByLabelText(/Password/i), 'validpass');
      await user.click(screen.getByRole('button', { name: /Sign in/i }));

      // Positive evidence first: the login succeeded and exitToDashboard()
      // began its exit choreography (isExiting flips synchronously, before
      // the 700ms timer fires, swapping in the exit-animation class).
      await waitFor(() => {
        expect(container.querySelector('.animate-login-card-out')).toBeInTheDocument();
      });

      // A successful login also flips `user` in AuthContext, which can
      // independently trigger LoginPage's unrelated #1889 "already
      // authenticated" effect (`navigate('/', { replace: true })`) on the
      // very same tick as exitToDashboard() arms its own 700ms timer. Clear
      // that out here — same isolation the T-055 guard test above uses —
      // so the check below is solely about the 700ms exit timer, not this
      // separate, immediate redirect.
      mockNavigate.mockClear();

      // Unmount right away — before the 700ms delay elapses — so any pending
      // timer must be cancelled by LoginPage's cleanup effect, not left to
      // fire against a gone component.
      unmount();

      // Wait out (with margin) the 700ms delay the pending timer would have
      // used to call navigate(). Bounded and deliberate, mirroring the T-055
      // guard test's own documented 800ms wait for the same timer.
      await new Promise(r => setTimeout(r, 800));

      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  describe('2FA flow', () => {
    // Helper: login as a 2FA user and get to the 2FA step
    async function loginWith2FA(twoFAMethods = ['totp', 'backup']) {
      const user = userEvent.setup();

      server.use(
        http.post('/api/v1/auth/login', () =>
          HttpResponse.json({
            requires_2fa: true,
            pre_auth_token: 'test-pre-auth-token',
            two_fa_methods: twoFAMethods,
          })
        )
      );

      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/Username/i), 'mfa-user');
      await user.type(screen.getByLabelText(/Password/i), 'mfa-password');
      await user.click(screen.getByRole('button', { name: /Sign in/i }));

      return user;
    }

    it('shows 2FA step when login returns requires_2fa', async () => {
      await loginWith2FA();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Two-Factor Authentication/i })).toBeInTheDocument();
      });
    });

    it('shows code input on the 2FA step', async () => {
      await loginWith2FA();

      await waitFor(() => {
        // The code input field is rendered
        expect(screen.getByRole('textbox', { name: /Verification Code/i })).toBeInTheDocument();
      });
    });

    it('submits 2FA verify request with code and pre_auth_token', async () => {
      let verifyCalled = false;
      let verifyBody: unknown;

      server.use(
        http.post('/api/v1/auth/2fa/verify', async ({ request }) => {
          verifyCalled = true;
          verifyBody = await request.json();
          return HttpResponse.json({
            access_token: 'final-jwt',
            token_type: 'bearer',
            user: {
              id: 1,
              username: 'mfa-user',
              role: 'admin',
              is_active: true,
              created_at: new Date().toISOString(),
            },
          });
        })
      );

      const user = await loginWith2FA();

      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /Verification Code/i })).toBeInTheDocument();
      });

      await user.type(screen.getByRole('textbox', { name: /Verification Code/i }), '123456');
      await user.click(screen.getByRole('button', { name: /Verify/i }));

      await waitFor(() => {
        expect(verifyCalled).toBe(true);
      });

      expect(verifyBody).toMatchObject({
        pre_auth_token: 'test-pre-auth-token',
        code: '123456',
        method: 'totp',
      });
    });

    it('returns to credentials step when back button is clicked', async () => {
      await loginWith2FA();

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Two-Factor Authentication/i })).toBeInTheDocument();
      });

      const user = userEvent.setup();
      const backButton = screen.getByRole('button', { name: /Back to login/i });
      await user.click(backButton);

      await waitFor(() => {
        // Back on the credentials step: brand logo, no step heading.
        expect(screen.getByAltText('AITO3D')).toBeInTheDocument();
      });
    });

    it('shows method selector when multiple 2FA methods are available', async () => {
      await loginWith2FA(['totp', 'email', 'backup']);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Two-Factor Authentication/i })).toBeInTheDocument();
      });

      // Multiple method buttons should be visible
      expect(screen.getByRole('button', { name: /Authenticator/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Email/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Backup/i })).toBeInTheDocument();
    });

    it('does not show method selector with only one 2FA method', async () => {
      await loginWith2FA(['totp']);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Two-Factor Authentication/i })).toBeInTheDocument();
      });

      // Single-method: no method selector buttons
      expect(screen.queryByRole('button', { name: /Authenticator/i })).not.toBeInTheDocument();
    });

    it('shows send code button when email method is selected', async () => {
      const _user = await loginWith2FA(['email']);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Two-Factor Authentication/i })).toBeInTheDocument();
      });

      // For email method the "Send code" button should be shown
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Send Code/i })).toBeInTheDocument();
      });
    });
  });

  describe('Remember Me', () => {
    const mockUser = {
      id: 1,
      username: 'testuser',
      role: 'admin' as const,
      is_active: true,
      created_at: new Date().toISOString(),
    };

    beforeEach(() => {
      vi.mocked(localStorage.setItem).mockClear();
      sessionStorage.clear();
      server.use(
        http.post('/api/v1/auth/login', () =>
          HttpResponse.json({
            access_token: 'test-token',
            token_type: 'bearer',
            user: mockUser,
          })
        ),
        // Prevent checkAuthStatus from clearing the token when getCurrentUser is called
        http.get('/api/v1/auth/me', () => HttpResponse.json(mockUser))
      );
    });

    it('renders Remember Me checkbox on credentials step', async () => {
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Remember Me/i)).toBeInTheDocument();
      });

      expect(screen.getByRole('checkbox', { name: /Remember Me/i })).not.toBeChecked();
    });

    it('does not persist token to localStorage when unchecked (default)', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/Username/i), 'testuser');
      await user.type(screen.getByLabelText(/Password/i), 'testpassword');
      await user.click(screen.getByRole('button', { name: /Sign in/i }));

      // Token must be in sessionStorage (tab-only) but not in localStorage
      await waitFor(() => {
        expect(vi.mocked(localStorage.setItem)).not.toHaveBeenCalledWith('auth_token', expect.any(String));
        expect(sessionStorage.getItem('auth_token')).toBe('test-token');
      });
    });

    it('persists token to localStorage when Remember Me is checked', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
      });

      await user.click(screen.getByRole('checkbox', { name: /Remember Me/i }));
      await user.type(screen.getByLabelText(/Username/i), 'testuser');
      await user.type(screen.getByLabelText(/Password/i), 'testpassword');
      await user.click(screen.getByRole('button', { name: /Sign in/i }));

      await waitFor(() => {
        expect(vi.mocked(localStorage.setItem)).toHaveBeenCalledWith('auth_token', 'test-token');
      });
    });

    it('carries Remember Me through 2FA verification', async () => {
      server.use(
        http.post('/api/v1/auth/login', () =>
          HttpResponse.json({
            requires_2fa: true,
            pre_auth_token: 'pre-token',
            two_fa_methods: ['totp'],
          })
        ),
        http.post('/api/v1/auth/2fa/verify', () =>
          HttpResponse.json({
            access_token: 'final-token',
            token_type: 'bearer',
            user: mockUser,
          })
        )
      );

      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
      });

      // Check Remember Me before submitting credentials
      await user.click(screen.getByRole('checkbox', { name: /Remember Me/i }));
      await user.type(screen.getByLabelText(/Username/i), 'testuser');
      await user.type(screen.getByLabelText(/Password/i), 'testpassword');
      await user.click(screen.getByRole('button', { name: /Sign in/i }));

      // Now on 2FA step — enter code and verify
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Two-Factor Authentication/i })).toBeInTheDocument();
      });

      await user.type(screen.getByRole('textbox', { name: /Verification Code/i }), '123456');
      await user.click(screen.getByRole('button', { name: /Verify/i }));

      // Token must be persisted to localStorage because Remember Me was checked
      await waitFor(() => {
        expect(vi.mocked(localStorage.setItem)).toHaveBeenCalledWith('auth_token', 'final-token');
      });
    });

    it('checkbox is not shown on 2FA step', async () => {
      server.use(
        http.post('/api/v1/auth/login', () =>
          HttpResponse.json({
            requires_2fa: true,
            pre_auth_token: 'pre-token',
            two_fa_methods: ['totp'],
          })
        )
      );

      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Username/i)).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/Username/i), 'testuser');
      await user.type(screen.getByLabelText(/Password/i), 'testpassword');
      await user.click(screen.getByRole('button', { name: /Sign in/i }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Two-Factor Authentication/i })).toBeInTheDocument();
      });

      expect(screen.queryByLabelText(/Remember Me/i)).not.toBeInTheDocument();
    });
  });

  describe('OIDC with Remember Me', () => {
    const mockUser = {
      id: 1,
      username: 'oidcuser',
      role: 'admin' as const,
      is_active: true,
      created_at: new Date().toISOString(),
    };

    beforeEach(() => {
      vi.mocked(localStorage.setItem).mockClear();
      sessionStorage.clear();
    });

    afterEach(() => {
      window.location.hash = '';
      window.history.pushState({}, '', '/login');
      sessionStorage.clear();
    });

    it('persists token to localStorage after OIDC redirect when Remember Me was set', async () => {
      sessionStorage.setItem('auth_remember_me', '1');
      server.use(
        http.post('/api/v1/auth/oidc/exchange', () =>
          HttpResponse.json({
            access_token: 'oidc-token',
            token_type: 'bearer',
            user: mockUser,
          })
        )
      );

      window.location.hash = '#oidc_token=test-exchange-token';
      render(<LoginPage />);

      await waitFor(() => {
        expect(vi.mocked(localStorage.setItem)).toHaveBeenCalledWith('auth_token', 'oidc-token');
      });
      expect(sessionStorage.getItem('auth_remember_me')).toBeNull();
    });

    it('carries Remember Me through OIDC + 2FA flow', async () => {
      sessionStorage.setItem('auth_remember_me', '1');
      server.use(
        http.post('/api/v1/auth/oidc/exchange', () =>
          HttpResponse.json({
            requires_2fa: true,
            pre_auth_token: 'oidc-pre-token',
            two_fa_methods: ['totp'],
          })
        ),
        http.post('/api/v1/auth/2fa/verify', () =>
          HttpResponse.json({
            access_token: 'oidc-2fa-token',
            token_type: 'bearer',
            user: mockUser,
          })
        )
      );

      window.location.hash = '#oidc_token=test-exchange-token';
      const user = userEvent.setup();
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Two-Factor Authentication/i })).toBeInTheDocument();
      });
      // Flag consumed on mount — no stale value for future flows
      expect(sessionStorage.getItem('auth_remember_me')).toBeNull();

      await user.type(screen.getByRole('textbox', { name: /Verification Code/i }), '123456');
      await user.click(screen.getByRole('button', { name: /Verify/i }));

      await waitFor(() => {
        expect(vi.mocked(localStorage.setItem)).toHaveBeenCalledWith('auth_token', 'oidc-2fa-token');
      });
    });

    it('cleans up auth_remember_me flag when OIDC returns an error', async () => {
      sessionStorage.setItem('auth_remember_me', '1');
      window.history.pushState({}, '', '/login?oidc_error=invalid_state');
      render(<LoginPage />);

      await waitFor(() => {
        expect(sessionStorage.getItem('auth_remember_me')).toBeNull();
      });
    });

    it('does not persist token to localStorage after OIDC redirect when Remember Me was not set', async () => {
      // No auth_remember_me flag set — token must stay session-only
      server.use(
        http.post('/api/v1/auth/oidc/exchange', () =>
          HttpResponse.json({
            access_token: 'oidc-session-token',
            token_type: 'bearer',
            user: mockUser,
          })
        )
      );

      window.location.hash = '#oidc_token=test-exchange-token';
      render(<LoginPage />);

      await waitFor(() => {
        expect(sessionStorage.getItem('auth_token')).toBe('oidc-session-token');
      });
      expect(vi.mocked(localStorage.setItem)).not.toHaveBeenCalledWith('auth_token', expect.any(String));
    });

    it('shows error toast when OIDC exchange returns unexpected response shape', async () => {
      sessionStorage.setItem('auth_remember_me', '1');
      server.use(
        // Response is missing both access_token and requires_2fa — hits the else branch
        http.post('/api/v1/auth/oidc/exchange', () =>
          HttpResponse.json({ token_type: 'bearer' })
        )
      );

      window.location.hash = '#oidc_token=test-exchange-token';
      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByText(/Login.*failed|failed.*login/i)).toBeInTheDocument();
      });
      // Flag must still be cleaned up even on malformed response
      expect(sessionStorage.getItem('auth_remember_me')).toBeNull();
    });

    it('writes auth_remember_me flag to sessionStorage before OIDC provider redirect', async () => {
      server.use(
        http.get('/api/v1/auth/oidc/providers', () =>
          HttpResponse.json([
            {
              id: 42,
              name: 'FlagIdP',
              issuer_url: 'https://flag.test',
              client_id: 'c',
              is_enabled: true,
              icon_url: null,
              has_icon: false,
              email_claim: 'email',
              require_email_verified: true,
              auto_create_users: false,
              auto_link_existing_accounts: false,
            },
          ])
        ),
        http.get('/api/v1/auth/oidc/authorize/42', () =>
          HttpResponse.json({ auth_url: 'https://flag.test/authorize?state=abc' })
        )
      );

      const user = userEvent.setup();
      render(<LoginPage />);

      // Tick "Remember Me"
      await waitFor(() => {
        expect(screen.getByRole('checkbox', { name: /Remember Me/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('checkbox', { name: /Remember Me/i }));

      // Wait for OIDC provider button to appear
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /FlagIdP/i })).toBeInTheDocument();
      });

      // Stub window.location so the OIDC redirect doesn't actually navigate.
      // Keep href valid so relative fetch URLs resolve correctly.
      Object.defineProperty(window, 'location', {
        writable: true,
        value: { ...window.location, href: 'http://localhost:3000/' },
      });

      await user.click(screen.getByRole('button', { name: /FlagIdP/i }));

      await waitFor(() => {
        expect(sessionStorage.getItem('auth_remember_me')).toBe('1');
      });
    });
  });

  // T-037: sanitizeRedirectTarget() guards the sessionStorage stash consumed
  // by resolvePostLoginRedirect() after a successful OIDC round-trip — the
  // one path where React state (router `location.state.from`) doesn't
  // survive, so a tampered `auth_post_login_redirect` value is the only way
  // in. Drive it end-to-end: seed sessionStorage, complete the OIDC
  // exchange, and assert where the post-login navigate() call actually goes.
  describe('post-login redirect sanitization (T-037)', () => {
    const mockUser = {
      id: 1,
      username: 'oidcuser',
      role: 'admin' as const,
      is_active: true,
      created_at: new Date().toISOString(),
    };

    let originalMatchMedia: typeof window.matchMedia;

    beforeEach(() => {
      sessionStorage.clear();
      mockNavigate.mockClear();
      // Force reduced motion so exitToDashboard() calls navigate() synchronously
      // (inside the OIDC-exchange .then()) instead of behind its normal 700ms
      // setTimeout. That keeps this test's assertion free of two hazards: (1) a
      // real, uncleared 700ms window.setTimeout left over from an *earlier*
      // test's render — LoginPage never clears it on unmount, so it can fire
      // mid-way through a later test and pollute mockNavigate's call list —
      // and (2) the unrelated #1889 "already authenticated" effect, which also
      // calls navigate('/', ...) the moment loginWithToken() sets the user,
      // but only on the *next* render (after this synchronous call). Reading
      // mockNavigate's first call therefore isolates exitToDashboard's own,
      // resolved-target call.
      originalMatchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: true,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      })) as typeof window.matchMedia;
      server.use(
        http.post('/api/v1/auth/oidc/exchange', () =>
          HttpResponse.json({
            access_token: 'oidc-token',
            token_type: 'bearer',
            user: mockUser,
          })
        )
      );
    });

    afterEach(() => {
      window.matchMedia = originalMatchMedia;
      window.location.hash = '';
      window.history.pushState({}, '', '/login');
      sessionStorage.clear();
    });

    async function waitForFirstNavigateCall() {
      await waitFor(
        () => {
          expect(mockNavigate.mock.calls.length).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 }
      );
      return mockNavigate.mock.calls[0];
    }

    it.each([
      ['//evil.com', 'protocol-relative'],
      ['https://evil.com', 'absolute URL'],
      ['/login', 'the login page itself (would loop)'],
    ])('falls back to "/" for a tampered redirect stash: %s (%s)', async (tampered) => {
      sessionStorage.setItem('auth_post_login_redirect', tampered);
      window.location.hash = '#oidc_token=test-exchange-token';

      render(<LoginPage />);

      const firstNavigateCall = await waitForFirstNavigateCall();
      expect(firstNavigateCall).toEqual(['/', { replace: true }]);
      // Belt-and-braces: the tampered value itself must never reach navigate().
      expect(firstNavigateCall[0]).not.toBe(tampered);
    });

    it('honours a safe stashed redirect target after OIDC login', async () => {
      sessionStorage.setItem('auth_post_login_redirect', '/archives');
      window.location.hash = '#oidc_token=test-exchange-token';

      render(<LoginPage />);

      const firstNavigateCall = await waitForFirstNavigateCall();
      expect(firstNavigateCall).toEqual(['/archives', { replace: true }]);
    });
  });

  // #1333: icon proxy — login page renders <img src> from /icon endpoint
  // rather than the upstream icon_url, so the strict img-src CSP holds.
  describe('OIDC icon proxy (#1333)', () => {
    beforeEach(() => {
      server.use(
        http.get('/api/v1/auth/status', () =>
          HttpResponse.json({ auth_enabled: true, setup_required: false })
        ),
      );
    });

    it('renders provider icon via the proxy URL when has_icon is true', async () => {
      server.use(
        http.get('/api/v1/auth/oidc/providers', () =>
          HttpResponse.json([
            {
              id: 7,
              name: 'IconProv',
              issuer_url: 'https://idp.test',
              client_id: 'c',
              is_enabled: true,
              icon_url: 'https://idp.test/icon.png',
              email_claim: 'email',
              require_email_verified: true,
              auto_create_users: false,
              auto_link_existing_accounts: false,
              has_icon: true,
            },
          ])
        ),
      );
      render(<LoginPage />);

      const button = await screen.findByRole('button', { name: /IconProv/i });
      const img = button.querySelector('img');
      expect(img).not.toBeNull();
      // Same-origin path — never the upstream icon_url. This is the entire
      // point of the proxy: keep img-src strictly 'self' data: blob:.
      expect(img!.getAttribute('src')).toBe('/api/v1/auth/oidc/providers/7/icon');
    });

    it('renders shield fallback when has_icon is false', async () => {
      server.use(
        http.get('/api/v1/auth/oidc/providers', () =>
          HttpResponse.json([
            {
              id: 8,
              name: 'NoIconProv',
              issuer_url: 'https://idp.test',
              client_id: 'c',
              is_enabled: true,
              icon_url: null,
              email_claim: 'email',
              require_email_verified: true,
              auto_create_users: false,
              auto_link_existing_accounts: false,
              has_icon: false,
            },
          ])
        ),
      );
      render(<LoginPage />);

      const button = await screen.findByRole('button', { name: /NoIconProv/i });
      expect(button.querySelector('img')).toBeNull();
    });

    it('renders mixed has_icon providers without crash', async () => {
      // N12 — multiple providers on the login page with a mix of
      // has_icon=true / false. No React-keys-collision warning, both
      // branches render correctly side by side.
      server.use(
        http.get('/api/v1/auth/oidc/providers', () =>
          HttpResponse.json([
            {
              id: 10,
              name: 'WithIcon',
              issuer_url: 'https://idp.test',
              client_id: 'c1',
              is_enabled: true,
              icon_url: 'https://idp.test/icon.png',
              has_icon: true,
              email_claim: 'email',
              require_email_verified: true,
              auto_create_users: false,
              auto_link_existing_accounts: false,
            },
            {
              id: 11,
              name: 'NoIcon',
              issuer_url: 'https://idp.test',
              client_id: 'c2',
              is_enabled: true,
              icon_url: null,
              has_icon: false,
              email_claim: 'email',
              require_email_verified: true,
              auto_create_users: false,
              auto_link_existing_accounts: false,
            },
          ])
        ),
      );
      render(<LoginPage />);

      const withIconBtn = await screen.findByRole('button', { name: /WithIcon/i });
      const noIconBtn = await screen.findByRole('button', { name: /NoIcon/i });
      expect(withIconBtn.querySelector('img')).not.toBeNull();
      expect(noIconBtn.querySelector('img')).toBeNull();
    });

    it('swaps in shield fallback when the icon fails to load', async () => {
      // I3 (#1333 review): the LoginPage must not show the browser
      // broken-image glyph to anonymous users. onError must fall back to
      // the Shield icon.
      server.use(
        http.get('/api/v1/auth/oidc/providers', () =>
          HttpResponse.json([
            {
              id: 9,
              name: 'FlakyIcon',
              issuer_url: 'https://idp.test',
              client_id: 'c',
              is_enabled: true,
              icon_url: 'https://idp.test/icon.png',
              email_claim: 'email',
              require_email_verified: true,
              auto_create_users: false,
              auto_link_existing_accounts: false,
              has_icon: true,
            },
          ])
        ),
      );
      render(<LoginPage />);

      const img = (await screen.findByRole('button', { name: /FlakyIcon/i })).querySelector('img');
      expect(img).not.toBeNull();
      // Fire the image's onError — jsdom doesn't fetch network resources
      // so we simulate the failure directly.
      fireEvent.error(img!);
      // After error, no more <img> in the button; Shield fallback rendered.
      await waitFor(() => {
        const button = screen.getByRole('button', { name: /FlakyIcon/i });
        expect(button.querySelector('img')).toBeNull();
      });
    });

    it('keeps each provider button\'s iconFailed state independent', async () => {
      // The OIDCProviderButton sub-component exists specifically so each
      // provider owns its own iconFailed state. If a future refactor hoists
      // useState into the parent loop, an error on provider A would also
      // hide provider B's icon — exactly the regression this test catches.
      server.use(
        http.get('/api/v1/auth/oidc/providers', () =>
          HttpResponse.json([
            {
              id: 21,
              name: 'AlphaIdP',
              issuer_url: 'https://a.test',
              client_id: 'a',
              is_enabled: true,
              icon_url: 'https://a.test/icon.png',
              email_claim: 'email',
              require_email_verified: true,
              auto_create_users: false,
              auto_link_existing_accounts: false,
              has_icon: true,
            },
            {
              id: 22,
              name: 'BetaIdP',
              issuer_url: 'https://b.test',
              client_id: 'b',
              is_enabled: true,
              icon_url: 'https://b.test/icon.png',
              email_claim: 'email',
              require_email_verified: true,
              auto_create_users: false,
              auto_link_existing_accounts: false,
              has_icon: true,
            },
          ])
        ),
      );
      render(<LoginPage />);

      const alphaImg = (await screen.findByRole('button', { name: /AlphaIdP/i })).querySelector('img');
      const betaImg = (await screen.findByRole('button', { name: /BetaIdP/i })).querySelector('img');
      expect(alphaImg).not.toBeNull();
      expect(betaImg).not.toBeNull();

      fireEvent.error(alphaImg!);

      // Alpha's icon swaps to the Shield fallback…
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /AlphaIdP/i }).querySelector('img')).toBeNull();
      });
      // …but Beta's icon stays put. If state leaks to the parent, this fails.
      expect(screen.getByRole('button', { name: /BetaIdP/i }).querySelector('img')).not.toBeNull();
    });
  });

  // T-039: the forgot-password / reset-password flow (forgotPasswordMutation,
  // resetPasswordMutation, and the client-side validation in the reset step's
  // handleResetSubmit) had zero frontend coverage.
  describe('forgot password', () => {
    beforeEach(() => {
      // The email-entry form only renders when advanced auth is enabled —
      // otherwise the modal shows the static "contact your admin" message.
      server.use(
        http.get('/api/v1/auth/advanced-auth/status', () =>
          HttpResponse.json({
            advanced_auth_enabled: true,
            smtp_configured: true,
            local_login_enabled: true,
            autologin_provider_id: null,
          })
        )
      );
    });

    it('submits the forgot-password form, shows a success toast, and resets the form', async () => {
      const user = userEvent.setup();
      server.use(
        http.post('/api/v1/auth/forgot-password', () =>
          HttpResponse.json({ message: 'If that email is registered, a reset link has been sent.' })
        )
      );

      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Forgot your password/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /Forgot your password/i }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Forgot Password/i })).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/Email Address/i), 'user@example.com');
      await user.click(screen.getByRole('button', { name: /Send Reset Email/i }));

      // Positive evidence: the handler's own message surfaces verbatim in the toast.
      await waitFor(() => {
        expect(screen.getByText('If that email is registered, a reset link has been sent.')).toBeInTheDocument();
      });

      // The modal closes on success...
      await waitFor(() => {
        expect(screen.queryByRole('heading', { name: /Forgot Password/i })).not.toBeInTheDocument();
      });
      // ...and the email field was cleared — reopening shows it blank.
      await user.click(screen.getByRole('button', { name: /Forgot your password/i }));
      await waitFor(() => {
        expect(screen.getByLabelText(/Email Address/i)).toHaveValue('');
      });
    });

    it('shows an error toast and keeps the modal open when the forgot-password request fails', async () => {
      const user = userEvent.setup();
      server.use(
        http.post('/api/v1/auth/forgot-password', () =>
          HttpResponse.json({ detail: 'Too many reset requests, try again later' }, { status: 429 })
        )
      );

      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Forgot your password/i })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: /Forgot your password/i }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /Forgot Password/i })).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText(/Email Address/i), 'user@example.com');
      await user.click(screen.getByRole('button', { name: /Send Reset Email/i }));

      await waitFor(() => {
        expect(screen.getByText('Too many reset requests, try again later')).toBeInTheDocument();
      });
      // A failed request must not close the modal — the user can retry.
      expect(screen.getByRole('heading', { name: /Forgot Password/i })).toBeInTheDocument();
    });

    describe('reset-password step', () => {
      afterEach(() => {
        window.location.hash = '';
        window.history.pushState({}, '', '/login');
      });

      async function renderResetStep() {
        // M-B: the page reads #reset_token=... from the URL fragment on mount
        // and switches straight to the reset-password step.
        window.location.hash = '#reset_token=test-reset-token';
        render(<LoginPage />);
        await waitFor(() => {
          expect(screen.getByRole('heading', { name: /Set New Password/i })).toBeInTheDocument();
        });
      }

      it('rejects mismatched passwords client-side without calling the API', async () => {
        const user = userEvent.setup();
        let confirmCalled = false;
        server.use(
          http.post('/api/v1/auth/forgot-password/confirm', () => {
            confirmCalled = true;
            return HttpResponse.json({ message: 'Password reset successfully' });
          })
        );

        await renderResetStep();

        await user.type(screen.getByLabelText(/New Password/i), 'password123');
        await user.type(screen.getByLabelText(/Confirm Password/i), 'password124');
        await user.click(screen.getByRole('button', { name: /Set New Password/i }));

        // Positive evidence first: the client-side mismatch message appears.
        await waitFor(() => {
          expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
        });
        // Only now assert the negative: the confirm endpoint was never hit.
        expect(confirmCalled).toBe(false);
      });

      it('rejects a too-short password client-side without calling the API', async () => {
        const user = userEvent.setup();
        let confirmCalled = false;
        server.use(
          http.post('/api/v1/auth/forgot-password/confirm', () => {
            confirmCalled = true;
            return HttpResponse.json({ message: 'Password reset successfully' });
          })
        );

        await renderResetStep();

        await user.type(screen.getByLabelText(/New Password/i), 'short1');
        await user.type(screen.getByLabelText(/Confirm Password/i), 'short1');
        await user.click(screen.getByRole('button', { name: /Set New Password/i }));

        await waitFor(() => {
          expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument();
        });
        expect(confirmCalled).toBe(false);
      });

      it('submits the reset token and new password, then returns to the credentials step on success', async () => {
        const user = userEvent.setup();
        let confirmBody: unknown;
        server.use(
          http.post('/api/v1/auth/forgot-password/confirm', async ({ request }) => {
            confirmBody = await request.json();
            return HttpResponse.json({ message: 'Password reset successfully' });
          })
        );

        await renderResetStep();

        await user.type(screen.getByLabelText(/New Password/i), 'newpassword1');
        await user.type(screen.getByLabelText(/Confirm Password/i), 'newpassword1');
        await user.click(screen.getByRole('button', { name: /Set New Password/i }));

        await waitFor(() => {
          expect(screen.getByText('Password reset successfully')).toBeInTheDocument();
        });
        expect(confirmBody).toEqual({ token: 'test-reset-token', new_password: 'newpassword1' });

        // Success returns to the credentials step: brand logo, no step heading.
        await waitFor(() => {
          expect(screen.getByAltText('AITO3D')).toBeInTheDocument();
        });
      });
    });
  });

  // #1889: an already-authenticated visit to /login must redirect to the app,
  // not render the credentials form. Browsers autocomplete the origin to its
  // most-visited path (/login), so live sessions kept landing on the form and
  // it looked like Bambuddy "never stays logged in".
  describe('authenticated redirect (#1889)', () => {
    const mockUser = {
      id: 1,
      username: 'testuser',
      role: 'admin' as const,
      is_active: true,
      created_at: new Date().toISOString(),
    };

    afterEach(() => {
      setAuthToken(null);
    });

    it('redirects an already-authenticated visitor away from /login', async () => {
      // A live session: token present, /api/v1/auth/me answers 200.
      setAuthToken('valid-token', 'session');
      server.use(http.get('/api/v1/auth/me', () => HttpResponse.json(mockUser)));
      mockNavigate.mockClear();

      render(<LoginPage />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
      });
    });

    it('does not redirect an unauthenticated visitor', async () => {
      // No token → checkAuthStatus leaves user null; the form must stay put.
      server.use(http.get('/api/v1/auth/me', () => HttpResponse.json(mockUser)));
      mockNavigate.mockClear();

      render(<LoginPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Sign in/i })).toBeInTheDocument();
      });
      expect(mockNavigate).not.toHaveBeenCalledWith('/', { replace: true });
    });
  });
});
