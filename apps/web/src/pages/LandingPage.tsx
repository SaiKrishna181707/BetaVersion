import { OperatorSignIn } from '../components/OperatorSignIn';
import { useEffect, useState, type FormEvent } from 'react';
import { Brand, Icon } from '@synthetic-beta/ui';
import { PRODUCT_INTELLIGENCE_KEY, productApi, type RunSummary } from '../lib/api';

const loadingMessages = [
  'Understanding your product…',
  'Reading public product information…',
  'Identifying your audience…',
  'Finding important workflows…',
  'Preparing your simulation…',
];

export function LandingPage() {
  const [companyName, setCompanyName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [building, setBuilding] = useState(false);
  const [messageIndex, setMessageIndex] = useState(0);
  const [error, setError] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>([]);

  useEffect(() => {
    let active = true;
    productApi.listRuns()
      .then(value => { if (active) setRuns(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!building) return;
    const timer = window.setInterval(
      () => setMessageIndex(index => (index + 1) % loadingMessages.length),
      1300,
    );
    return () => window.clearInterval(timer);
  }, [building]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBuilding(true);
    setMessageIndex(0);
    setError('');
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

  return <div className="vision-landing">
    <header className="vision-landing-nav">
      <Brand /><OperatorSignIn />
      {runs.length > 0 ? <a href="#recent-runs">View runs</a> : null}
    </header>

    <main id="main">
      <section className="vision-landing-hero" aria-labelledby="landing-title">
        <div className="vision-landing-copy">
          <span className="vision-product-name">CENTOPUS</span>
          <h1 id="landing-title">Test before your users do.</h1>
          <p>See how autonomous synthetic users navigate,<br />struggle, and succeed in your real product.</p>
        </div>

        <form className="vision-build-card" onSubmit={event => void submit(event)}>
          <label>
            <span>Product / Company</span>
            <input
              value={companyName}
              onChange={event => setCompanyName(event.target.value)}
              placeholder="Company name"
              minLength={2}
              maxLength={120}
              autoComplete="organization"
              required
            />
          </label>
          <label>
            <span>Website</span>
            <input
              value={websiteUrl}
              onChange={event => setWebsiteUrl(event.target.value)}
              placeholder="https://yourproduct.com"
              type="url"
              autoComplete="url"
              required
            />
          </label>
          {error ? <p className="field-error" role="alert">{error}</p> : null}
          <button className="button button-primary vision-build-button" disabled={building}>
            {building ? loadingMessages[messageIndex] : 'Build Product'}
            {!building ? <Icon name="arrow" size={16} /> : <span className="vision-loader" aria-hidden="true" />}
          </button>
          <small>We use publicly available information from your website to prefill your test setup. Everything remains editable.</small>
        </form>
      </section>

      {runs.length > 0 ? <section id="recent-runs" className="vision-recent-runs" aria-labelledby="recent-runs-title">
        <div className="vision-section-heading">
          <span>PREVIOUS RUNS</span>
          <h2 id="recent-runs-title">Continue your research.</h2>
        </div>
        <div className="vision-run-list">
          {runs.slice(0, 6).map(run => {
            const destination = run.status === 'QUEUED'
              ? 'population'
              : run.status === 'COMPLETED'
                ? 'report'
                : 'live';
            return <a key={run.run_id} href={`#/runs/${run.run_id}/${destination}`}>
              <span>
                <strong>{run.configuration?.product_name || run.configuration?.target_url || run.run_id}</strong>
                <small>{run.configuration?.objective || run.run_id}</small>
              </span>
              <span className="vision-run-status">{run.status}<Icon name="arrow" size={14} /></span>
            </a>;
          })}
        </div>
      </section> : null}
    </main>

    <footer className="vision-landing-footer">
      <span>Centopus</span>
      <span>Observe real behavior. Measure what happened.</span>
    </footer>
  </div>;
}
