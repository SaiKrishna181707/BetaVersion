import type { ReactNode } from 'react';
import { GUARDRAILS, formatUsd } from '@synthetic-beta/contracts';
import { Badge, Brand, Icon } from '@synthetic-beta/ui';

export interface WorkspaceShellProps {
  children: ReactNode;
  /** The last breadcrumb and the sidebar item that is marked current. */
  surface?: 'new-run' | 'overview';
  crumb: string;
  /** One honest line about what is running, or not running, right now. */
  footerNote?: string;
  /** Right-hand topbar badge. Defaults to the local preview marker. */
  status?: ReactNode;
}

const NAV = [
  { surface: 'overview', href: '#/', icon: 'grid', label: 'Overview' },
  { surface: 'new-run', href: '#/new', icon: 'plus', label: 'New run' },
] as const;

export function WorkspaceShell({
  children,
  surface = 'new-run',
  crumb,
  footerNote = 'Configuration stays in this browser. No agents are running.',
  status,
}: WorkspaceShellProps) {
  return <div className="workspace-layout"><aside className="workspace-sidebar"><Brand /><div className="workspace-selector"><span className="workspace-avatar">S</span><div><strong>Sandbox workspace</strong><span>Local development</span></div></div><span className="nav-caption mono">WORKSPACE</span><nav aria-label="Workspace">{NAV.map(item => <a key={item.href} className={item.surface === surface ? 'active' : undefined} href={item.href} aria-current={item.surface === surface ? 'page' : undefined}><Icon name={item.icon} />{item.label}{item.surface === surface && <span className="nav-active-dot" />}</a>)}</nav><div className="sidebar-empty"><Icon name="terminal" size={18} /><p>Your first session<br />starts with a clear goal.</p><span>Configure {'\u2192'} review {'\u2192'} run</span></div><div className="sidebar-budget"><div><Icon name="shield" size={14} /> GLOBAL CEILING</div><strong className="mono">{formatUsd(GUARDRAILS.GLOBAL_SPEND_CEILING_USD * 100)}<span>USD</span></strong><p>Configured limit</p></div><div className="workspace-user"><span className="workspace-avatar small">L</span><span>Local workspace</span><Badge>DEV</Badge></div></aside><div className="workspace-content"><header className="workspace-topbar"><div className="mobile-brand"><Brand compact /></div><div className="breadcrumbs"><span>Workspace</span><Icon name="chevron" size={12} /><strong>{crumb}</strong></div>{status ?? <Badge tone="accent"><span className="dot" />Local preview</Badge>}</header><main id="main" className="new-run-main">{children}</main><footer className="workspace-footer"><Icon name="lock" size={12} />{footerNote}</footer></div></div>;
}