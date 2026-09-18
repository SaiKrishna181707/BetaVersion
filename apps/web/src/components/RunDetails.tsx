import type { ReactNode } from 'react';
import { Badge } from '@synthetic-beta/ui';
import type { FailureClass, SessionStatus } from '@synthetic-beta/contracts';

/** One recorded number. Nothing here is estimated; every value comes from the run store. */
export function Stat({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return <div className="stat"><span className="stat-label">{label}</span><strong className="mono">{value}</strong>{detail !== undefined && <span className="stat-detail">{detail}</span>}</div>;
}

export function StatusBadge({ status }: { status: SessionStatus }) {
  const tone = status === 'COMPLETED'
    ? 'accent'
    : status === 'FAILED' || status === 'TIMED_OUT'
      ? 'warning'
      : 'neutral';
  return <Badge tone={tone}>{status}</Badge>;
}

/** A session that reached the objective has no failure class, and says so instead of guessing. */
export function FailureBadge({ failure }: { failure: FailureClass | null }) {
  if (failure === null) return <span className="muted failure-none">reached objective</span>;
  return <Badge tone="warning">{failure}</Badge>;
}

export function SectionCard({ title, caption, actions, children }: { title: string; caption?: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="run-card"><header className="run-card-head"><div><h2>{title}</h2>{caption !== undefined && <p>{caption}</p>}</div>{actions}</header>{children}</section>;
}