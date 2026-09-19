import { Badge, Icon } from '@synthetic-beta/ui';
import type { RichPersona } from '../lib/api';

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() || '').join('') || 'A';
}

function money(persona: RichPersona): string {
  if (persona.income_range) return persona.income_range;
  if (typeof persona.income_annual === 'number') {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
      .format(persona.income_annual);
  }
  return 'Not provided';
}

export function AgentCard({
  persona,
  selected = false,
  status,
  onSelect,
}: {
  persona: RichPersona;
  selected?: boolean;
  status?: string;
  onSelect: () => void;
}) {
  const name = persona.display_name || persona.persona_id;
  return <button type="button" className={`agent-card${selected ? ' selected' : ''}`} onClick={onSelect}>
    <div className="agent-card-top">
      <span className="agent-avatar" aria-hidden="true">{initials(name)}</span>
      {status ? <Badge tone={status === 'COMPLETED' ? 'accent' : status === 'ABANDONED' ? 'warning' : 'neutral'}>{status}</Badge> : <Icon name="arrow" size={15} />}
    </div>
    <div className="agent-card-name">
      <strong>{name}</strong>
      <span>{[persona.age ? `${persona.age}` : null, persona.occupation].filter(Boolean).join(' · ') || persona.cohort}</span>
    </div>
    <dl className="agent-card-facts">
      <div><dt>Income</dt><dd>{money(persona)}</dd></div>
      <div><dt>Tech</dt><dd>{persona.technical_ability}</dd></div>
      <div><dt>Patience</dt><dd>{persona.patience}</dd></div>
      <div><dt>Loyalty</dt><dd>{persona.customer_loyalty || 'Not provided'}</dd></div>
      <div><dt>Device</dt><dd>{persona.device_class.replace('_WEB', '')}</dd></div>
    </dl>
    <span className="agent-card-footer">View profile <Icon name="chevron" size={12} /></span>
  </button>;
}
