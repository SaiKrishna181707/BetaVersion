import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Brand, Button } from '@centopus/ui';
import { LandingPage } from './pages/LandingPage';
import { NewRunPage } from './pages/NewRunPage';
import { PopulationPage } from './pages/PopulationPage';
import { LiveRunPage } from './pages/LiveRunPage';
import { RunReportPage } from './pages/RunReportPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { parseRoute, titleFor, type RouteMatch } from './router';
import { authConfigured, beginLogin, finishLogin, tokens } from './lib/auth';
import { apiBaseUrl } from './lib/api';

const subscribe = (callback: () => void) => {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
};

// useSyncExternalStore requires a stable snapshot, so the parse is cached per hash value.
let cachedHash: string | null = null;
let cachedMatch: RouteMatch = parseRoute('');
const getMatch = (): RouteMatch => {
  const hash = window.location.hash;
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedMatch = parseRoute(hash);
  }
  return cachedMatch;
};

class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) {
      return <main className="error-page">
        <Brand />
        <h1>Something interrupted the workspace.</h1>
        <p>Your last saved draft stays in this browser. Reload to try again.</p>
        <Button onClick={() => window.location.reload()}>Reload workspace</Button>
      </main>;
    }
    return this.props.children;
  }
}


function AuthGate({ children }: { children: ReactNode }) {
  const productionAuthMisconfigured = import.meta.env.PROD && !authConfigured() && Boolean(apiBaseUrl());
  const [ready, setReady] = useState(() => !productionAuthMisconfigured && (!authConfigured() || Boolean(tokens())));
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (!code) return;
    finishLogin(code).then(() => {
      const cleanUrl = window.location.origin + window.location.pathname + window.location.hash;
      window.history.replaceState({}, document.title, cleanUrl);
      setReady(true);
    }).catch(cause => setError(cause instanceof Error ? cause.message : 'Sign-in failed.'));
  }, []);

  if (productionAuthMisconfigured) {
    return <main className="error-page"><Brand /><h1>Authentication configuration is missing.</h1><p>This production build cannot safely connect to the protected Centopus API until Cognito PKCE settings are configured.</p></main>;
  }
  if (!authConfigured() || ready) return <>{children}</>;
  return <main className="error-page"><Brand /><h1>{error ? 'Sign-in failed.' : 'Sign in to Centopus'}</h1><p>{error || 'Authenticate as an authorized operator to access runs and reports.'}</p><Button onClick={() => void beginLogin().catch(cause => setError(cause instanceof Error ? cause.message : 'Could not start sign-in.'))}>{error ? 'Try again' : 'Sign in'}</Button></main>;
}

function RouteSurface({ match }: { match: RouteMatch }) {
  if (match.definition?.id === 'new-run') return <NewRunPage />;
  if (match.definition?.id === 'population-preview' && match.params.runId) {
    return <PopulationPage runId={match.params.runId} />;
  }
  if (match.definition?.id === 'live-run' && match.params.runId) {
    return <LiveRunPage runId={match.params.runId} />;
  }
  if (match.definition?.id === 'run-report' && match.params.runId) {
    return <RunReportPage runId={match.params.runId} />;
  }
  if (match.definition?.id === 'session-detail' && match.params.runId && match.params.sessionId) {
    return <SessionDetailPage runId={match.params.runId} sessionId={match.params.sessionId} />;
  }
  if (match.definition?.status === 'READY') return <LandingPage />;
  return <NotFoundPage requested={match.requested} planned={match.definition} />;
}

export function App() {
  const match = useSyncExternalStore(subscribe, getMatch);

  useEffect(() => {
    document.title = titleFor(match);
    window.scrollTo(0, 0);
    document.querySelector<HTMLElement>('h1')?.focus();
  }, [match]);

  return <AppErrorBoundary>
    <a className="skip-link" href="#main">Skip to content</a>
    <AuthGate><RouteSurface match={match} /></AuthGate>
  </AppErrorBoundary>;
}
