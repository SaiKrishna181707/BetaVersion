import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  estimateCost,
  formatUsd,
  validateRunConfiguration,
  type CostEstimate,
  type RunConfiguration,
  type RunDraft,
} from '@synthetic-beta/contracts';
import { Badge, Button, FieldsetTitle, Icon } from '@synthetic-beta/ui';
import { WorkspaceShell } from '../components/WorkspaceShell';
import { ProductFields } from '../components/ProductFields';
import { ExecutionFields } from '../components/ExecutionFields';
import { CostSummary } from '../components/CostSummary';
import { RunReview } from '../components/RunReview';
import { authorizedDomains, initialConfiguration } from '../lib/config';
import { createLocalRunGateway } from '../lib/local-run-gateway';

function gateway() {
  return createLocalRunGateway(window.localStorage, authorizedDomains);
}

function bundledDemoConfiguration(): RunConfiguration {
  return {
    ...initialConfiguration,
    target_url: `${window.location.origin}/demo-target/`,
    product_description: 'Fieldwork is a lightweight project workspace for small teams planning product launches.',
    target_audience: 'Early-stage founders trying a project collaboration tool for the first time.',
    objective: 'Create a project and invite a teammate to collaborate.',
    user_count: 5,
    authorization_acknowledged: false,
  };
}

export function NewRunPage() {
  const [configuration, setConfiguration] = useState<RunConfiguration>(initialConfiguration);
  const [attempted, setAttempted] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [savedDraft, setSavedDraft] = useState<RunDraft | null>(null);
  const [notice, setNotice] = useState('');
  const [storageWarning, setStorageWarning] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const draft = await gateway().loadDraft();
        if (active && draft) {
          setConfiguration({ ...draft.configuration, authorization_acknowledged: false });
          setSavedDraft(draft);
          setNotice('Your reviewed draft was restored. Confirm authorization again before saving changes.');
        }
      } catch (cause) {
        if (active) {
          setStorageWarning(cause instanceof Error ? cause.message : 'Could not load a saved draft.');
        }
      }
    };
    void load();
    return () => { active = false; };
  }, []);

  const validation = validateRunConfiguration(configuration, authorizedDomains);
  const errors = attempted && !validation.ok ? validation.errors : {};

  let estimate: CostEstimate | null = null;
  try {
    estimate = estimateCost(configuration);
  } catch {
    /* Incomplete numeric fields have no estimate. */
  }

  const update = <K extends keyof RunConfiguration>(key: K, value: RunConfiguration[K]) => {
    setConfiguration(current => ({ ...current, [key]: value }));
    setSavedDraft(null);
    setNotice('');
  };

  const closeReview = () => {
    setReviewing(false);
    reviewButton.current?.focus();
  };

  const review = (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (!validation.ok) {
      const firstKey = Object.keys(validation.errors)[0];
      if (firstKey) document.getElementById(firstKey)?.focus();
      return;
    }
    if (!estimate || estimate.exceeds_run_cap || estimate.exceeds_global_ceiling) {
      document.getElementById('run_hard_cap_usd')?.focus();
      return;
    }
    setReviewing(true);
  };

  const save = async () => {
    const draft = await gateway().saveReviewedDraft(configuration);
    setSavedDraft(draft);
    setStorageWarning('');
    setNotice('Reviewed draft saved in this browser. No agents have been launched.');
    closeReview();
  };

  const loadBundledDemo = () => {
    setConfiguration(bundledDemoConfiguration());
    setAttempted(false);
    setReviewing(false);
    setSavedDraft(null);
    setStorageWarning('');
    setNotice('Bundled authorized demo loaded. Confirm permission before reviewing the run.');
    window.setTimeout(() => document.getElementById('target_url')?.focus(), 0);
  };

  return (
    <WorkspaceShell>
      <div className="new-run-heading">
        <div>
          <div className="eyebrow">A CLEAR GOAL. AN OBSERVABLE OUTCOME.</div>
          <h1 tabIndex={-1}>Create a run<span>.</span></h1>
          <p>See how synthetic users find their way through your product.</p>
        </div>
        <Badge><Icon name="file" size={12} />{savedDraft ? 'DRAFT SAVED' : 'NEW CONFIGURATION'}</Badge>
      </div>

      <div className="run-steps" aria-label="Configuration progress">
        <span className="current"><span>1</span>Configure</span><i />
        <span><span>2</span>Review</span><i />
        <span className="step-offline"><Icon name="lock" size={12} />Run <small>Not connected</small></span>
      </div>

      {notice && (
        <div className="notice notice-success" role="status">
          <Icon name="check" size={17} /><span>{notice}</span>
        </div>
      )}
      {storageWarning && (
        <div className="notice notice-warning" role="alert">
          <Icon name="info" size={17} /><span>{storageWarning}</span>
        </div>
      )}

      <form ref={formRef} className="run-layout" onSubmit={review} noValidate>
        <div className="run-form">
          <ProductFields configuration={configuration} errors={errors} update={update} />
          <ExecutionFields configuration={configuration} errors={errors} update={update} />

          <section className="form-section authorization-section">
            <FieldsetTitle
              number="03"
              title="Permission to test"
              description="Useful evidence starts with a controlled environment."
            />
            <label className={`authorization-check ${errors.authorization_acknowledged ? 'invalid' : ''}`}>
              <input
                id="authorization_acknowledged"
                type="checkbox"
                checked={configuration.authorization_acknowledged}
                onChange={event => update('authorization_acknowledged', event.target.checked)}
                aria-invalid={Boolean(errors.authorization_acknowledged)}
                aria-describedby={errors.authorization_acknowledged ? 'authorization-error' : 'authorization-help'}
              />
              <span>
                <strong>I own this product or have permission to test it.</strong>
                <span id="authorization-help">
                  This is a sandbox or staging environment. I’ll use disposable accounts and won’t authorize
                  real purchases, destructive actions, or third-party testing.
                </span>
              </span>
            </label>
            {errors.authorization_acknowledged && (
              <p id="authorization-error" className="field-error">{errors.authorization_acknowledged}</p>
            )}
            <div className="domain-note">
              <Icon name="globe" size={13} />
              <span>
                Configured hosts:{' '}
                <span className="mono">
                  {authorizedDomains.length ? authorizedDomains.join(', ') : 'None — configuration required'}
                </span>
              </span>
            </div>
          </section>

          <div className="form-submit">
            <p><Icon name="lock" size={13} />Review first. Nothing launches automatically.</p>
            <button ref={reviewButton} type="submit" className="button button-primary">
              Review run
              {estimate && <span className="button-cost mono">{formatUsd(estimate.total_cents)} est.</span>}
              <Icon name="arrow" size={16} />
            </button>
          </div>
          {attempted && !validation.ok && (
            <p className="submit-error field-error" role="alert">
              Check the highlighted fields before reviewing your run.
            </p>
          )}
        </div>

        <CostSummary
          configuration={configuration}
          estimate={estimate}
          budgetError={errors.run_hard_cap_usd}
          onBudgetChange={value => update('run_hard_cap_usd', value)}
        />
      </form>

      {reviewing && estimate && (
        <RunReview configuration={configuration} estimate={estimate} onClose={closeReview} onSave={save} />
      )}

      <div className="new-run-bottom">
        <a href="#/" className="text-link">
          <Icon name="arrow" size={14} className="back-arrow" />Back to overview
        </a>
        <div className="row">
          <Button variant="ghost" onClick={loadBundledDemo}>Load bundled demo</Button>
          <Button
            variant="ghost"
            onClick={() => {
              setConfiguration(initialConfiguration);
              setAttempted(false);
              setNotice('Form reset. Your last saved draft is still stored until you save a new one.');
              setSavedDraft(null);
              formRef.current?.querySelector('input')?.focus();
            }}
          >
            Reset form
          </Button>
        </div>
      </div>
    </WorkspaceShell>
  );
}
