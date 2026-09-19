import { Badge, Icon } from '@synthetic-beta/ui';
import type { SyntheticPersona } from '@synthetic-beta/contracts';

export function AgentCard({ persona, selected = false, result, onSelect }: {
  persona: SyntheticPersona;
  selected?: boolean;
  result?: { status: string; actionCount?: number; elapsedMs?: number };
  onSelect: () => void;
}) {
  const tone = result?.status === 'COMPLETED' ? 'accent' : result ? 'warning' : 'neutral';
  return <button className={`agent-card${selected ? ' is-selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
    <div className="agent-card-top">
      <span className="agent-avatar"><Icon name="users" size={18} /></span>
      <Badge tone={tone}>{result?.status || persona.cohort}</Badge>
    </div>
    <div><h3>{persona.display_name || persona.persona_id}</h3><p>{persona.occupation || persona.biography || persona.goal_context}</p></div>
    <dl className="agent-traits">
      <div><dt>Device</dt><dd>{persona.device_class.replace('_', ' ')}</dd></div>
      <div><dt>Ability</dt><dd>{persona.technical_ability}</dd></div>
      <div><dt>Patience</dt><dd>{persona.patience}</dd></div>
    </dl>
    {result ? <div className="agent-result-line">
      <span>{result.actionCount ?? 0} recorded actions</span>
      <span>{result.elapsedMs === undefined ? 'Evidence available' : `${(result.elapsedMs / 1000).toFixed(1)}s`}</span>
    </div> : <span className="agent-card-action">Edit profile <Icon name="arrow" size={13} /></span>}
  </button>;
}
