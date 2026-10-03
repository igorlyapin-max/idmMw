import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { DlqPage } from './pages/DlqPage';
import { RbacPage } from './pages/RbacPage';
import { TargetSystemsPage } from './pages/TargetSystemsPage';
import {
  fetchEffectiveAdminPermissions,
  fetchAuthSession,
  loginLocal,
  loginSso,
  oidcLoginUrl,
  logout,
  samlLoginUrl,
  type AuthSession,
  type EffectiveAdminPermissions,
} from './api/client';
import { APP_VERSION } from './version';
import './App.css';

export type PermissionsStatus = 'loading' | 'ready' | 'failed';

function LoginScreen({
  session,
  onSession,
}: {
  session: AuthSession;
  onSession: (session: AuthSession) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const submitLocal = async () => {
    setLoading(true);
    setMessage('');
    try {
      onSession(await loginLocal(username, password));
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const submitSso = async () => {
    setLoading(true);
    setMessage('');
    try {
      onSession(await loginSso());
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };
  const providers = session.ssoProviders ?? ['header'];
  const redirectTo = (url: string) => {
    window.location.assign(url);
  };

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <h1 className="auth-title">
          <span>idmMw Admin</span>
          <span className="app-version">v{APP_VERSION}</span>
        </h1>
        <div className="form-grid">
          {session.mode !== 'sso' && (
            <>
              <label>
                User
                <input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <button
                className="button primary"
                onClick={submitLocal}
                disabled={loading}
              >
                Sign in
              </button>
            </>
          )}
          {session.mode !== 'local' && providers.includes('header') && (
            <button className="button" onClick={submitSso} disabled={loading}>
              Sign in with Header SSO
            </button>
          )}
          {session.mode !== 'local' && providers.includes('oidc') && (
            <button
              className="button"
              onClick={() => redirectTo(oidcLoginUrl())}
              disabled={loading}
            >
              Sign in with OIDC
            </button>
          )}
          {session.mode !== 'local' && providers.includes('saml') && (
            <button
              className="button"
              onClick={() => redirectTo(samlLoginUrl())}
              disabled={loading}
            >
              Sign in with SAML
            </button>
          )}
        </div>
        {message && <p className="error-text">{message}</p>}
      </section>
    </main>
  );
}

function App() {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [effectivePermissions, setEffectivePermissions] =
    useState<EffectiveAdminPermissions | null>(null);
  const [permissionsStatus, setPermissionsStatus] =
    useState<PermissionsStatus>('loading');
  const [loading, setLoading] = useState(true);

  const loadEffectivePermissions = async (nextSession: AuthSession) => {
    setPermissionsStatus('loading');
    if (!nextSession.authEnabled) {
      setEffectivePermissions(null);
      setPermissionsStatus('ready');
      return;
    }
    if (!nextSession.authenticated) {
      setEffectivePermissions(null);
      setPermissionsStatus('ready');
      return;
    }
    try {
      setEffectivePermissions(await fetchEffectiveAdminPermissions());
      setPermissionsStatus('ready');
    } catch {
      setEffectivePermissions(null);
      setPermissionsStatus('failed');
    }
  };

  useEffect(() => {
    fetchAuthSession()
      .then(async (nextSession) => {
        setSession(nextSession);
        await loadEffectivePermissions(nextSession);
      })
      .catch(() =>
        setSession({
          authEnabled: true,
          authenticated: false,
          mode: 'local',
        }),
      )
      .finally(() => setLoading(false));
  }, []);

  const handleLogout = async () => {
    await logout();
    const nextSession = await fetchAuthSession();
    setSession(nextSession);
    await loadEffectivePermissions(nextSession);
  };

  const handleSession = async (nextSession: AuthSession) => {
    setSession(nextSession);
    await loadEffectivePermissions(nextSession);
  };

  if (loading || !session) {
    return <main className="page-shell">Loading</main>;
  }

  if (session.authEnabled && !session.authenticated) {
    return <LoginScreen session={session} onSession={handleSession} />;
  }

  return (
    <BrowserRouter>
      <div className="app-frame">
        <header className="topbar">
          <div className="brand">
            <span>idmMw</span>
            <span className="app-version">v{APP_VERSION}</span>
          </div>
          <nav className="nav-links">
            <Link to="/">DLQ</Link>
            <Link to="/target-systems">Target systems</Link>
            {effectivePermissions?.superadmin && <Link to="/rbac">RBAC</Link>}
          </nav>
          <div className="session-info">
            <span>{session.user?.name ?? 'admin'}</span>
            {session.authEnabled && (
              <button className="button ghost" onClick={handleLogout}>
                Logout
              </button>
            )}
          </div>
        </header>
        <Routes>
          <Route path="/" element={<DlqPage />} />
          <Route
            path="/target-systems"
            element={
              <TargetSystemsPage
                authEnabled={session.authEnabled}
                effectivePermissions={effectivePermissions}
                permissionsStatus={permissionsStatus}
              />
            }
          />
          <Route
            path="/rbac"
            element={
              <RbacPage
                authEnabled={session.authEnabled}
                effective={effectivePermissions}
                permissionsStatus={permissionsStatus}
              />
            }
          />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
