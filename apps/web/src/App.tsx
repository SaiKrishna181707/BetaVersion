import { Component, useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { Brand, Button } from '@synthetic-beta/ui';
import { LandingPage } from './pages/LandingPage';
import { NewRunPage } from './pages/NewRunPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { parseRoute, titleFor, type RouteMatch } from './router';

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

function RouteSurface({ match }: { match: RouteMatch }) {
  if (match.definition?.id === 'new-run') return <NewRunPage />;
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
    <RouteSurface match={match} />
  </AppErrorBoundary>;
}