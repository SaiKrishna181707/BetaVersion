import { useState } from 'react';
import { Badge, Icon } from '@synthetic-beta/ui';
import { ILLUSTRATIVE_SESSIONS } from '../data/illustration';

export function SessionIllustration() {
  const [selected, setSelected] = useState(0);
  const session = ILLUSTRATIVE_SESSIONS[selected] ?? ILLUSTRATIVE_SESSIONS[0];
  return <div className="session-illustration" aria-label="Illustrative synthetic browser sessions">
    <div className="illustration-heading"><span><Icon name="activity" size={14} /> SESSION OBSERVER</span><span className="illustration-label">ILLUSTRATIVE PREVIEW</span></div>
    <div className="browser-preview">
      <div className="browser-toolbar"><span className="window-dots"><i /><i /><i /></span><div className="address-bar"><Icon name="lock" size={10} /><span className="mono">demo.local{session.route}</span></div><Icon name="plus" size={13} /></div>
      <div className="demo-browser-content">
        <div className="demo-rail" aria-hidden="true"><span className="demo-logo">f.</span><Icon name="grid" size={15} /><Icon name="layers" size={15} /><Icon name="users" size={15} /></div>
        <div className="demo-workspace"><div className="demo-breadcrumb">Fieldwork <Icon name="chevron" size={10} /> Workspace</div><div className="demo-page-title"><h3>{session.page}</h3><span className="demo-avatar">F</span></div>
          <div className="demo-tabs"><span className="selected">Overview</span><span>Activity</span><span>Settings</span></div>
          <div className="demo-project"><div className="demo-project-icon"><Icon name={selected === 2 ? 'users' : 'layers'} size={18} /></div><div><strong>{selected === 2 ? 'Your team' : 'Product launch'}</strong><p>{selected === 2 ? 'One invitation sent' : 'A shared space for the next big thing.'}</p></div><span className="demo-ellipsis">···</span></div>
          <div className="demo-placeholder" aria-hidden="true"><span /><span /><span /></div>
          <div className={`synthetic-cursor cursor-position-${selected}`}><Icon name="cursor" size={19} /><span className="mono">synthetic #{session.id}</span></div>
        </div>
      </div>
      <div className="browser-caption"><Icon name={session.icon} size={13} /><span>{session.action}</span><span className="mono">#{session.id}</span></div>
    </div>
    <div className="observer-sessions"><div className="session-table-heading"><span>SYNTHETIC USER</span><span>STATE</span></div>
      {ILLUSTRATIVE_SESSIONS.map((item, index) => <button className={`illustrative-session ${selected === index ? 'is-selected' : ''}`} key={item.id} onClick={() => setSelected(index)} aria-pressed={selected === index} aria-label={`Preview synthetic user ${item.id}, ${item.status.toLowerCase()}`}><span className="session-mini-avatar"><Icon name={item.icon} size={14} /></span><span className="session-id mono">#{item.id}</span><span className="session-page">{item.page}</span><Badge tone={item.tone}><span className="dot" />{item.status}</Badge></button>)}
    </div>
    <div className="illustration-note" aria-live="polite"><span className="note-rule" /><p>{session.behavior}</p></div>
    <p className="preview-disclaimer">Example UI · synthetic personas · no live sessions</p>
  </div>;
}
