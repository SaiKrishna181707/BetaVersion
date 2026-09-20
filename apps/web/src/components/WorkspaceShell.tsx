import { OperatorSignIn } from './OperatorSignIn';
import { useEffect, useState, type ReactNode } from 'react';
import { GUARDRAILS, formatUsd } from '@synthetic-beta/contracts';
import { Badge, Brand, Icon } from '@synthetic-beta/ui';
import { productApi } from '../lib/api';

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const [hash, setHash] = useState(() => window.location.hash);
  const [backend, setBackend] = useState<'CHECKING' | 'CONNECTED' | 'UNAVAILABLE'>('CHECKING');

  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  useEffect(() => {
    let active = true;
    productApi.health()
      .then(result => {
        if (active) setBackend(result.status === 'ok' && result.execution_available ? 'CONNECTED' : 'UNAVAILABLE');
      })
      .catch(() => {
        if (active) setBackend('UNAVAILABLE');
      });
    return () => { active = false; };
  }, []);

  const section = hash.includes('/population')
    ? 'Population'
    : hash.includes('/live')
      ? 'Live simulation'
      : hash.includes('/report')
        ? 'Results'
        : hash.includes('/sessions/')
          ? 'Agent experience'
          : 'New run';

  return <div className="workspace-layout vision-workspace">
    <aside className="workspace-sidebar vision-sidebar">
      <Brand />
      <div className="workspace-selector">
        <span className="workspace-avatar">C</span>
        <div><strong>Centopus</strong><span>Product research workspace</span></div>
      </div>
      <span className="nav-caption mono">WORKSPACE</span>
      <nav aria-label="Workspace">
        <a href="#/"><Icon name="grid" /> Home</a>
        <a href="#/new" className={hash.startsWith('#/new') ? 'active' : ''}><Icon name="plus" /> New run</a>
      </nav>
      <div className="sidebar-empty">
        <Icon name="activity" size={18} />
        <p>Product to population.<br />Population to evidence.</p>
        <span>BUILD → OBSERVE → LEARN</span>
      </div>
      <div className="sidebar-budget">
        <div><Icon name="shield" size={14} /> EXECUTION ALLOWANCE</div>
        <strong className="mono">{formatUsd(GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100)}<span>USD</span></strong>
        <p>Cumulative estimated spend reservations</p>
      </div>
    </aside>

    <div className="workspace-content">
      <header className="workspace-topbar vision-topbar">
        <OperatorSignIn />
        <div className="mobile-brand"><Brand compact /></div>
        <div className="breadcrumbs"><span>Centopus</span><Icon name="chevron" size={12} /><strong>{section}</strong></div>
        <Badge tone={backend === 'CONNECTED' ? 'accent' : backend === 'CHECKING' ? 'neutral' : 'warning'}>
          <span className="dot" />
          {backend === 'CONNECTED' ? 'API CONNECTED' : backend === 'CHECKING' ? 'CHECKING API' : 'API UNAVAILABLE'}
        </Badge>
      </header>
      <main id="main" className="new-run-main vision-main">{children}</main>
      <footer className="workspace-footer">
        <Icon name="shield" size={12} />
        Runs stay inside backend-enforced URL, time, action, concurrency and budget limits.
      </footer>
    </div>
  </div>;
}
