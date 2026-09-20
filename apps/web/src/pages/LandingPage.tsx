import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Icon } from '@centopus/ui';
import { PRODUCT_INTELLIGENCE_KEY, productApi, type RunSummary } from '../lib/api';
import { authConfigured, beginLogin, tokens } from '../lib/auth';

const PENDING_LANDING_ACTION_KEY = 'centopus:landing-pending-action';
const PENDING_LANDING_DRAFT_KEY = 'centopus:landing-pending-draft';
const AUTH_CHANGED_EVENT = 'centopus-auth-changed';

const loadingMessages = [
  'Understanding your product…',
  'Reading public product information…',
  'Identifying your audience…',
  'Finding important workflows…',
  'Preparing your simulation…',
];

type LandingDraft = {
  companyName: string;
  websiteUrl: string;
};

function readPendingDraft(): LandingDraft | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_LANDING_DRAFT_KEY);
    return raw ? JSON.parse(raw) as LandingDraft : null;
  } catch {
    return null;
  }
}

type BarStyle = CSSProperties & {
  '--bar-scale': string;
  '--bar-scale-high': string;
};

const gradientBarStyles: BarStyle[] = Array.from({ length: 20 }, (_, index) => {
  const position = index / 19;
  const distance = Math.abs(position - 0.5);
  const scale = 0.72 + 0.28 * Math.pow(distance * 2, 1.15);

  return {
    '--bar-scale': scale.toFixed(3),
    '--bar-scale-high': Math.min(scale + 0.08, 1).toFixed(3),
    animationDelay: (index * 0.5) + 's',
  };
});

export function LandingPage() {
  const pendingDraft = readPendingDraft();
  const [companyName, setCompanyName] = useState(pendingDraft?.companyName || '');
  const [websiteUrl, setWebsiteUrl] = useState(pendingDraft?.websiteUrl || '');
  const [building, setBuilding] = useState(false);
  const [messageIndex, setMessageIndex] = useState(0);
  const [error, setError] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [previousOpen, setPreviousOpen] = useState(false);

  useEffect(() => {
    let active = true;

    const syncAuthenticatedLanding = async () => {
      if (authConfigured() && !tokens()) return;

      productApi.listRuns()
        .then(value => { if (active) setRuns(value); })
        .catch(() => undefined);

      const pendingAction = window.sessionStorage.getItem(PENDING_LANDING_ACTION_KEY);
      if (pendingAction === 'previous') {
        window.sessionStorage.removeItem(PENDING_LANDING_ACTION_KEY);
        if (active) setPreviousOpen(true);
        return;
      }

      if (pendingAction !== 'build') return;
      const draft = readPendingDraft();
      window.sessionStorage.removeItem(PENDING_LANDING_ACTION_KEY);
      window.sessionStorage.removeItem(PENDING_LANDING_DRAFT_KEY);
      if (!draft || !active) return;

      setCompanyName(draft.companyName);
      setWebsiteUrl(draft.websiteUrl);
      setBuilding(true);
      setMessageIndex(0);
      setError('');

      try {
        const intelligence = await productApi.analyzeProduct({
          company_name: draft.companyName.trim(),
          website_url: draft.websiteUrl.trim(),
        });
        if (!active) return;
        window.sessionStorage.setItem(PRODUCT_INTELLIGENCE_KEY, JSON.stringify(intelligence));
        window.location.hash = '#/new';
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : 'Could not analyze this product.');
        setBuilding(false);
      }
    };

    void syncAuthenticatedLanding();
    window.addEventListener(AUTH_CHANGED_EVENT, syncAuthenticatedLanding);
    return () => {
      active = false;
      window.removeEventListener(AUTH_CHANGED_EVENT, syncAuthenticatedLanding);
    };
  }, []);

  useEffect(() => {
    if (!building) return;
    const timer = window.setInterval(
      () => setMessageIndex(index => (index + 1) % loadingMessages.length),
      1300,
    );
    return () => window.clearInterval(timer);
  }, [building]);

  useEffect(() => {
    if (!previousOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviousOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [previousOpen]);

  const handlePrevious = async () => {
    setError('');
    if (authConfigured() && !tokens()) {
      window.sessionStorage.setItem(PENDING_LANDING_ACTION_KEY, 'previous');
      try {
        await beginLogin();
      } catch (cause) {
        window.sessionStorage.removeItem(PENDING_LANDING_ACTION_KEY);
        setError(cause instanceof Error ? cause.message : 'Could not open previous runs.');
      }
      return;
    }

    setPreviousOpen(true);
    productApi.listRuns()
      .then(setRuns)
      .catch(cause => setError(cause instanceof Error ? cause.message : 'Could not load previous runs.'));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');

    if (authConfigured() && !tokens()) {
      window.sessionStorage.setItem(PENDING_LANDING_ACTION_KEY, 'build');
      window.sessionStorage.setItem(PENDING_LANDING_DRAFT_KEY, JSON.stringify({ companyName, websiteUrl }));
      try {
        await beginLogin();
      } catch (cause) {
        window.sessionStorage.removeItem(PENDING_LANDING_ACTION_KEY);
        setError(cause instanceof Error ? cause.message : 'Could not start authentication.');
      }
      return;
    }

    setBuilding(true);
    setMessageIndex(0);
    try {
      const intelligence = await productApi.analyzeProduct({
        company_name: companyName.trim(),
        website_url: websiteUrl.trim(),
      });
      window.sessionStorage.setItem(PRODUCT_INTELLIGENCE_KEY, JSON.stringify(intelligence));
      window.location.hash = '#/new';
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not analyze this product.');
      setBuilding(false);
    }
  };

  return <div className="centopus-portfolio-landing">
    <div className="centopus-gradient-bars" aria-hidden="true">
      {gradientBarStyles.map((style, index) => <span key={index} style={style} />)}
    </div>
    <div className="centopus-landing-grid" aria-hidden="true" />

    <header className="centopus-landing-header">
      <button
        type="button"
        className="centopus-previous-button"
        onClick={() => void handlePrevious()}
        aria-expanded={previousOpen}
        aria-controls="previous-runs-panel"
      >
        <span aria-hidden="true">←</span>
        <span>Previous</span>
      </button>

      <a className="centopus-centered-brand" href="#/" aria-label="Centopus home">
        <img src="/centopus-mark.svg" alt="" />
        <span>centopus</span>
      </a>
    </header>

    <main id="main" className="centopus-landing-main">
      <h1 className="centopus-visually-hidden">Centopus product testing</h1>

      <form className="centopus-entry-form" onSubmit={event => void submit(event)}>
        <label>
          <span className="centopus-visually-hidden">Product / Company</span>
          <input
            value={companyName}
            onChange={event => setCompanyName(event.target.value)}
            placeholder="Company / Product name"
            minLength={2}
            maxLength={120}
            autoComplete="organization"
            required
          />
        </label>

        <label>
          <span className="centopus-visually-hidden">Website</span>
          <input
            value={websiteUrl}
            onChange={event => setWebsiteUrl(event.target.value)}
            placeholder="https://yourproduct.com"
            type="url"
            autoComplete="url"
            required
          />
        </label>

        <button
          className="centopus-send-button"
          type="submit"
          disabled={building}
          aria-label={building ? loadingMessages[messageIndex] : 'Build Product'}
          title={building ? loadingMessages[messageIndex] : 'Build Product'}
        >
          {building
            ? <span className="centopus-submit-loader" aria-hidden="true" />
            : <Icon name="arrow" size={21} />}
        </button>
      </form>

      {error
        ? <p className="centopus-form-message is-error" role="alert">{error}</p>
        : building
          ? <p className="centopus-form-message" role="status">{loadingMessages[messageIndex]}</p>
          : null}
    </main>

    {previousOpen ? <>
      <aside
        id="previous-runs-panel"
        className="centopus-previous-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="previous-runs-title"
      >
        <div className="centopus-previous-panel-header">
          <div>
            <span>HISTORY</span>
            <h2 id="previous-runs-title">Previous runs</h2>
          </div>
          <button
            type="button"
            className="centopus-panel-close"
            onClick={() => setPreviousOpen(false)}
            aria-label="Close previous runs"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="centopus-previous-list">
          {runs.length > 0 ? runs.map(run => {
            const destination = run.status === 'QUEUED'
              ? 'population'
              : run.status === 'COMPLETED'
                ? 'report'
                : 'live';

            return <a
              key={run.run_id}
              href={'#/runs/' + run.run_id + '/' + destination}
              className="centopus-previous-run"
            >
              <span>
                <strong>{run.configuration?.product_name || run.configuration?.target_url || run.run_id}</strong>
                <small>{run.configuration?.objective || run.run_id}</small>
              </span>
              <span className="centopus-previous-status">
                {run.status}
                <Icon name="arrow" size={14} />
              </span>
            </a>;
          }) : <div className="centopus-previous-empty">
            <strong>No previous runs yet.</strong>
            <span>Your completed and active runs will appear here.</span>
          </div>}
        </div>
      </aside>

      <button
        type="button"
        className="centopus-drawer-scrim"
        onClick={() => setPreviousOpen(false)}
        aria-label="Close previous runs"
        tabIndex={-1}
      />
    </> : null}
  </div>;
}
