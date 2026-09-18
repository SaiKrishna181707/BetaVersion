import { useEffect, useRef, useState } from 'react';
import { formatUsd, type CostEstimate, type RunConfiguration } from '@synthetic-beta/contracts';
import { Badge, Button, Icon } from '@synthetic-beta/ui';

export function RunReview({ configuration, estimate, onClose, onSave }: { configuration: RunConfiguration; estimate: CostEstimate; onClose: () => void; onSave: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const save = async () => {
    if (saving) return;
    setSaving(true); setError('');
    try { await onSave(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save this draft. Please try again.'); }
    finally { setSaving(false); }
  };
  return <dialog ref={dialog} className="review-dialog" aria-labelledby="review-title" aria-describedby="review-description" onCancel={event => { event.preventDefault(); if (!saving) onClose(); }}><div className="review-topline"><Badge>CONFIGURATION REVIEW</Badge><button className="icon-button" aria-label="Close review" disabled={saving} onClick={onClose}><Icon name="close" /></button></div><h2 id="review-title">A deliberate start.</h2><p id="review-description">Check the objective, boundaries, and estimate before saving your draft.</p><dl className="review-details"><div><dt>Target</dt><dd className="mono">{configuration.target_url}</dd></div><div><dt>Objective</dt><dd>{configuration.objective}</dd></div><div><dt>Population</dt><dd>{configuration.user_count} synthetic {configuration.user_count === 1 ? 'user' : 'users'} · up to {Math.min(configuration.user_count, configuration.batch_size)} at a time</dd></div><div><dt>Session timeout</dt><dd>{configuration.max_session_seconds} seconds</dd></div><div><dt>Planning estimate</dt><dd className="mono">{formatUsd(estimate.total_cents)}</dd></div><div><dt>Hard budget cap</dt><dd className="mono">{formatUsd(configuration.run_hard_cap_usd * 100)}</dd></div></dl><div className="review-disclosure"><Icon name="info" size={17} /><p><strong>This saves a local draft.</strong> Browser execution is not connected. No sessions will start and no AWS charges will be incurred. The estimate uses the dated handoff pricing snapshot and explicit allowances.</p></div>{error && <p className="review-error field-error" role="alert">{error}</p>}<div className="review-actions"><Button variant="secondary" onClick={onClose} disabled={saving}>Back to editing</Button><Button onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save reviewed draft'}<Icon name="check" size={16} /></Button></div></dialog>;
}
