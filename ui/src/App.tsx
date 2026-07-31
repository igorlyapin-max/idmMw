import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { DlqPage } from './pages/DlqPage';
import { TargetSystemsPage } from './pages/TargetSystemsPage';
import {
  fetchAuthSession,
  loginLocal,
  loginSso,
  logout,
  type AuthSession,
} from './api/client';
import { APP_VERSION } from './version';
import './App.css';

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
          {session.mode !== 'local' && (
            <button className="button" onClick={submitSso} disabled={loading}>
              Sign in with SSO
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAuthSession()
      .then(setSession)
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
    setSession(await fetchAuthSession());
  };

  if (loading || !session) {
    return <main className="page-shell">Loading</main>;
  }

  if (session.authEnabled && !session.authenticated) {
    return <LoginScreen session={session} onSession={setSession} />;
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
          <Route path="/target-systems" element={<TargetSystemsPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default App;
