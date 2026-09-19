import { useEffect, useState, type FormEvent } from 'react';
import { Brand, Icon } from '@synthetic-beta/ui';
import { PRODUCT_INTELLIGENCE_KEY, productApi, type RunSummary } from '../lib/api';

export function LandingPage() {
  const [companyName, setCompanyName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>([]);

  useEffect(() => {
    let active = true;
    productApi.listRuns().then(value => { if (active) setRuns(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBuilding(true); setError('');
    try {
      const intelligence = await productApi.analyzeProduct({ company_name: companyName, website_url: websiteUrl });
      window.sessionStorage.setItem(PRODUCT_INTELLIGENCE_KEY, JSON.stringify(intelligence));
      window.location.hash = '#/new';
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not build product intelligence.');
      setBuilding(false);
    }
  };

  return <div className="product-landing">
    <header className="product-nav"><Brand /></header>
    <main id="main">
      <section className="product-hero">
        <div className="product-hero-copy"><span className="eyebrow">SYNTHETIC BETA</span><h1>Test before your users do.</h1><p>See how autonomous synthetic users navigate,<br />struggle, and succeed in your real product.</p></div>
        <form className="build-product-card" onSubmit={event => void submit(event)}>
          <label>Product / Company<input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Company name" minLength={2} maxLength={120} required /></label>
          <label>Website<input value={websiteUrl} onChange={e => setWebsiteUrl(e.target.value)} placeholder="https://yourproduct.com" type="url" required /></label>
          {error ? <p className="field-error" role="alert">{error}</p> : null}
          <button className="button button-primary product-build-button" disabled={building}>{building ? 'Understanding your product...' : 'Build product'} <Icon name="arrow" size={16} /></button>
          <small>We use publicly available information from your website<br />to prefill your test setup. Everything remains editable.</small>
        </form>
      </section>
      {runs.length > 0 ? <section className="recent-runs" aria-labelledby="recent-runs-title">
        <div><span className="eyebrow">RECENT RESEARCH</span><h2 id="recent-runs-title">Continue where your agents left off.</h2></div>
        <div className="recent-run-list">{runs.slice(0, 4).map(run => <a key={run.run_id} href={`#/runs/${run.run_id}/${run.status === 'QUEUED' ? 'population' : run.status === 'COMPLETED' ? 'report' : 'live'}`}>
          <span><strong>{run.configuration?.product_name || run.configuration?.company_name || run.configuration?.target_url || run.run_id}</strong><small>{run.configuration?.objective || run.run_id}</small></span>
          <span className="run-status">{run.status}<Icon name="arrow" size={14} /></span>
        </a>)}</div>
      </section> : null}
    </main>
    <footer className="product-footer"><span>Synthetic Beta</span></footer>
  </div>;
}
