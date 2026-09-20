import { useEffect, useRef, useState } from 'react';
import { formatUsd, type CostEstimate, type RunConfiguration } from '@centopus/contracts';
import { Badge, Button, Icon } from '@centopus/ui';
import { productApi } from '../lib/api';

export function RunReview({
  configuration,
  estimate,
  onClose,
  onSave,
}: {
  configuration: RunConfiguration;
  estimate: CostEstimate;
  onClose: () => void;
  onSave: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');

  const apiBase = import.meta.env.VITE_API_BASE_URL || '';

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  const save = async () => {
    if (saving || launching) return;
    setSaving(true);
    setError('');
    try {
      await onSave();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save this draft. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const launchOnAws = async () => {
    if (saving || launching || !apiBase) return;
    setLaunching(true);
    setError('');
    try {
      const createData = await productApi.createRun(configuration);
      const runId = createData.run_id;
      await productApi.startRun(runId, configuration.batch_size);
      window.location.hash = `#/runs/${runId}/live`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed launching AWS run.');
      setLaunching(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="review-dialog"
      aria-labelledby="review-title"
      aria-describedby="review-description"
      onCancel={event => {
        event.preventDefault();
        if (!saving && !launching) onClose();
      }}
    >
      <div className="review-topline">
        <Badge>CONFIGURATION REVIEW</Badge>
        <button className="icon-button" aria-label="Close review" disabled={saving || launching} onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      <h2 id="review-title">A deliberate start.</h2>
      <p id="review-description">Check the objective, boundaries, and estimate before launching your synthetic cohort.</p>

      <dl className="review-details">
        <div><dt>Target</dt><dd className="mono">{configuration.target_url}</dd></div>
        <div><dt>Objective</dt><dd>{configuration.objective}</dd></div>
        <div>
          <dt>Population</dt>
          <dd>
            {configuration.user_count} synthetic {configuration.user_count === 1 ? 'user' : 'users'} · up to {Math.min(configuration.user_count, configuration.batch_size)} at a time
          </dd>
        </div>
        <div><dt>Session timeout</dt><dd>{configuration.max_session_seconds} seconds</dd></div>
        <div><dt>Planning estimate</dt><dd className="mono">{formatUsd(estimate.total_cents)}</dd></div>
        <div><dt>Run estimate allowance</dt><dd className="mono">{formatUsd(configuration.run_hard_cap_usd * 100)}</dd></div>
      </dl>

      <div className="review-disclosure">
        <Icon name="info" size={17} />
        <p>
          {apiBase ? (
            <>
              <strong>Cloud API configured.</strong> Launch requests execution from the configured backend. Operator sign-in and available execution resources are required.
            </>
          ) : (
            <>
              <strong>Local Draft Mode.</strong> No cloud backend configured. Saving will keep the draft in local browser storage.
            </>
          )}
        </p>
      </div>

      {error && <p className="review-error field-error" role="alert">{error}</p>}

      <div className="review-actions">
        <Button variant="secondary" onClick={onClose} disabled={saving || launching}>
          Back to editing
        </Button>
        {apiBase && (
          <Button onClick={() => void launchOnAws()} disabled={saving || launching}>
            {launching ? 'Launching on AWS…' : 'Launch live run on AWS'}
            <Icon name="activity" size={16} />
          </Button>
        )}
        <Button variant={apiBase ? 'ghost' : 'primary'} onClick={() => void save()} disabled={saving || launching}>
          {saving ? 'Saving…' : 'Save draft'}
          <Icon name="check" size={16} />
        </Button>
      </div>
    </dialog>
  );
}
