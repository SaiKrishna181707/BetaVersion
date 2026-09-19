import { useEffect, useState, type ReactNode } from 'react';
import { GUARDRAILS, formatUsd } from '@synthetic-beta/contracts';
import { Badge, Brand, Icon } from '@synthetic-beta/ui';

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const [currentHash, setCurrentHash] = useState(() => (typeof window !== 'undefined' ? window.location.hash : ''));

  useEffect(() => {
    const handleHashChange = () => {
      setCurrentHash(window.location.hash);
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const isOverview = currentHash === '' || currentHash === '#/' || currentHash === '#';
  const isNewRun = currentHash.startsWith('#/new');

  return (
    <div className="workspace-layout">
      <aside className="workspace-sidebar">
        <Brand />
        <div className="workspace-selector">
          <span className="workspace-avatar">S</span>
          <div>
            <strong>Sandbox workspace</strong>
            <span>Local development</span>
          </div>
        </div>
        <span className="nav-caption mono">WORKSPACE</span>
        <nav aria-label="Workspace">
          <a href="#/" className={isOverview ? 'active' : ''} aria-current={isOverview ? 'page' : undefined}>
            <Icon name="grid" />
            Overview
            {isOverview && <span className="nav-active-dot" />}
          </a>
          <a href="#/new" className={isNewRun ? 'active' : ''} aria-current={isNewRun ? 'page' : undefined}>
            <Icon name="plus" />
            New run
            {isNewRun && <span className="nav-active-dot" />}
          </a>
        </nav>
        <div className="sidebar-empty">
          <Icon name="terminal" size={18} />
          <p>
            Your first session<br />starts with a clear goal.
          </p>
          <span>Configure → review → run</span>
        </div>
        <div className="sidebar-budget">
          <div>
            <Icon name="shield" size={14} /> GLOBAL CEILING
          </div>
          <strong className="mono">
            {formatUsd(GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100)}
            <span>USD</span>
          </strong>
          <p>Configured limit · execution offline</p>
        </div>
        <div className="workspace-user">
          <span className="workspace-avatar small">L</span>
          <span>Local workspace</span>
          <Badge>DEV</Badge>
        </div>
      </aside>
      <div className="workspace-content">
        <header className="workspace-topbar">
          <div className="mobile-brand">
            <Brand compact />
          </div>
          <div className="breadcrumbs">
            <span>Workspace</span>
            <Icon name="chevron" size={12} />
            <strong>{isNewRun ? 'New run' : isOverview ? 'Overview' : 'Execution'}</strong>
          </div>
          <Badge tone="accent">
            <span className="dot" />
            Local preview
          </Badge>
        </header>
        <main id="main" className="new-run-main">
          {children}
        </main>
        <footer className="workspace-footer">
          <Icon name="lock" size={12} />
          Configuration stays in this browser. No agents are running.
        </footer>
      </div>
    </div>
  );
}
