import { Brand, Icon } from '@centopus/ui';
import type { RouteDefinition } from '../router';

export function NotFoundPage({ requested, planned }: { requested: string; planned: RouteDefinition | null }) {
  return <div className="landing-page">
    <header className="landing-header container">
      <Brand />
      <nav aria-label="Main navigation">
        <a className="button button-secondary header-cta" href="#/new">New run <Icon name="arrow" size={15} /></a>
      </nav>
    </header>
    <main id="main" className="container not-found">
      <p className="eyebrow"><span className="eyebrow-line" />{planned ? 'PLANNED SURFACE' : 'ROUTE NOT FOUND'}</p>
      <h1 tabIndex={-1}>{planned ? 'This screen is registered, not built.' : 'That route does not exist.'}</h1>
      <p className="hero-description">
        {planned
          ? <>The route table reserves <span className="mono">{planned.pattern}</span> for this surface. It arrives with the execution phase; the current foundation ships the overview and New run.</>
          : <>Nothing is registered for <span className="mono">{requested}</span>. Check the address, or start from the overview.</>}
      </p>
      <div className="hero-actions">
        <a className="button button-primary" href="#/">Back to overview <Icon name="arrow" size={16} /></a>
        <a className="text-link" href="#/new">Create a run <Icon name="chevron" size={13} /></a>
      </div>
    </main>
  </div>;
}