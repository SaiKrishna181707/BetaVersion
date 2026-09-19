import { useEffect, useState, type ReactNode } from 'react';
import { GUARDRAILS, formatUsd } from '@synthetic-beta/contracts';
import { Badge, Brand, Icon } from '@synthetic-beta/ui';
import { productApi } from '../lib/api';

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const [hash, setHash] = useState(() => window.location.hash);
  const [cloudState, setCloudState] = useState<'LOADING' | 'AVAILABLE' | 'UNAVAILABLE'>('LOADING');
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    let active = true;
    productApi.health().then(result => { if (active) setCloudState(result.status === 'ok' && result.execution_available ? 'AVAILABLE' : 'UNAVAILABLE'); })
      .catch(() => { if (active) setCloudState('UNAVAILABLE'); });
    return () => { active = false; };
  }, []);
  const section = hash.includes('/population') ? 'Population' : hash.includes('/live') ? 'Live execution' : hash.includes('/report') ? 'Results' : hash.includes('/sessions/') ? 'Agent experience' : 'New research';
  return <div className="workspace-layout">
    <aside className="workspace-sidebar">
      <Brand />
      <div className="workspace-selector"><span className="workspace-avatar">S</span><div><strong>Product research</strong><span>Evidence workspace</span></div></div>
      <span className="nav-caption mono">WORKSPACE</span>
      <nav aria-label="Workspace"><a href="#/"><Icon name="grid" />Overview</a><a href="#/new" className={hash.startsWith('#/new') ? 'active' : ''}><Icon name="plus" />New run</a></nav>
      <div className="sidebar-empty"><Icon name="activity" size={18} /><p>Product to population.<br />Population to evidence.</p><span>BUILD → OBSERVE → LEARN</span></div>
      <div className="sidebar-budget"><div><Icon name="shield" size={14} /> GLOBAL CEILING</div><strong className="mono">{formatUsd(GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100)}<span>USD</span></strong><p>Hard safety limit per workspace</p></div>
      <div className="workspace-user"><span className="workspace-avatar small">A</span><span>Cloud workspace</span></div>
    </aside>
    <div className="workspace-content">
      <header className="workspace-topbar"><div className="mobile-brand"><Brand compact /></div><div className="breadcrumbs"><span>Synthetic Beta</span><Icon name="chevron" size={12} /><strong>{section}</strong></div><Badge tone={cloudState === 'AVAILABLE' ? 'accent' : cloudState === 'UNAVAILABLE' ? 'warning' : 'neutral'}><span className="dot" />{cloudState === 'AVAILABLE' ? 'AWS CONNECTED' : cloudState === 'UNAVAILABLE' ? 'API UNAVAILABLE' : 'CHECKING API'}</Badge></header>
      <main id="main" className="new-run-main">{children}</main>
      <footer className="workspace-footer"><Icon name="shield" size={12} />Runs execute within explicit time, action, budget, and concurrency limits.</footer>
    </div>
  </div>;
}
