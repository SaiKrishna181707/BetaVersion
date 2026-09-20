import { useEffect, useState, type FormEvent } from 'react';
import { Button, Icon } from '@centopus/ui';
import type { RichPersona } from '../lib/api';

const levels = ['LOW', 'MEDIUM', 'HIGH'] as const;

function TextField({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  return <label className="persona-field">
    <span>{label}</span>
    {multiline
      ? <textarea value={value} onChange={event => onChange(event.target.value)} />
      : <input value={value} onChange={event => onChange(event.target.value)} />}
  </label>;
}

export function PersonaEditor({
  persona,
  saving,
  onClose,
  onSave,
}: {
  persona: RichPersona;
  saving: boolean;
  onClose?: () => void;
  onSave: (persona: RichPersona) => Promise<void>;
}) {
  const [draft, setDraft] = useState<RichPersona>(persona);
  const [error, setError] = useState('');

  useEffect(() => setDraft(persona), [persona]);

  const set = <K extends keyof RichPersona>(key: K, value: RichPersona[K]) => {
    setDraft(current => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await onSave(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this agent.');
    }
  };

  return <section className="persona-editor" aria-labelledby="persona-editor-title">
    <div className="persona-editor-heading">
      <div>
        <span className="eyebrow">COMPLETE AGENT PROFILE</span>
        <h2 id="persona-editor-title">{draft.display_name || draft.persona_id}</h2>
        <p>These traits define who the agent is before the real product session begins.</p>
      </div>
      {onClose ? <button className="icon-button" onClick={onClose} aria-label="Close profile"><Icon name="close" /></button> : null}
    </div>

    <form onSubmit={event => void submit(event)}>
      <div className="persona-grid">
        <TextField label="Full name" value={draft.display_name || ''} onChange={value => set('display_name', value)} />
        <label className="persona-field"><span>Age</span><input type="number" min={18} max={100} value={draft.age ?? ''} onChange={event => set('age', event.target.value ? Number(event.target.value) : undefined)} /></label>
        <TextField label="Age range" value={draft.age_band || ''} onChange={value => set('age_band', value)} />
        <TextField label="Gender" value={draft.gender || ''} onChange={value => set('gender', value)} />
        <TextField label="Location" value={draft.location || draft.location_band || ''} onChange={value => { set('location', value); set('location_band', value); }} />
        <TextField label="Occupation" value={draft.occupation || ''} onChange={value => set('occupation', value)} />
        <TextField label="Education" value={draft.education || ''} onChange={value => set('education', value)} />
        <label className="persona-field"><span>Income band</span><select value={draft.income_band || ''} onChange={event => set('income_band', event.target.value ? event.target.value as RichPersona['income_band'] : undefined)}><option value="">Not provided</option><option value="LOW">Low</option><option value="MIDDLE">Middle</option><option value="HIGH">High</option></select></label>
        <TextField label="Income / range" value={draft.income_range || ''} onChange={value => set('income_range', value)} />
        <TextField label="Household context" value={draft.household_context || ''} onChange={value => set('household_context', value)} />
        <label className="persona-field"><span>Device</span><select value={draft.device_class} onChange={event => set('device_class', event.target.value as RichPersona['device_class'])}><option value="DESKTOP">Desktop</option><option value="MOBILE_WEB">Mobile</option><option value="TABLET">Tablet</option></select></label>
        <label className="persona-field"><span>Technical ability</span><select value={draft.technical_ability} onChange={event => set('technical_ability', event.target.value as RichPersona['technical_ability'])}>{levels.map(level => <option key={level}>{level}</option>)}</select></label>
        <label className="persona-field"><span>Product familiarity</span><select value={draft.product_familiarity} onChange={event => set('product_familiarity', event.target.value as RichPersona['product_familiarity'])}><option value="NEW">New</option><option value="CATEGORY_FAMILIAR">Category familiar</option><option value="POWER_USER">Power user</option></select></label>
        <label className="persona-field"><span>Reading behavior</span><select value={draft.reading_style} onChange={event => set('reading_style', event.target.value as RichPersona['reading_style'])}><option value="SCANNING">Scanning</option><option value="SELECTIVE">Selective</option><option value="THOROUGH">Thorough</option></select></label>
        <label className="persona-field"><span>Patience</span><select value={draft.patience} onChange={event => set('patience', event.target.value as RichPersona['patience'])}>{levels.map(level => <option key={level}>{level}</option>)}</select></label>
        <label className="persona-field"><span>Privacy sensitivity</span><select value={draft.privacy_sensitivity || 'MEDIUM'} onChange={event => set('privacy_sensitivity', event.target.value as RichPersona['privacy_sensitivity'])}>{levels.map(level => <option key={level}>{level}</option>)}</select></label>
        <label className="persona-field"><span>Price sensitivity</span><select value={draft.price_sensitivity || 'MEDIUM'} onChange={event => set('price_sensitivity', event.target.value as RichPersona['price_sensitivity'])}>{levels.map(level => <option key={level}>{level}</option>)}</select></label>
        <label className="persona-field"><span>Customer loyalty</span><select value={draft.customer_loyalty || 'MEDIUM'} onChange={event => set('customer_loyalty', event.target.value as RichPersona['customer_loyalty'])}>{levels.map(level => <option key={level}>{level}</option>)}</select></label>
      </div>

      <div className="persona-grid narrative">
        <TextField label="Primary motivation" value={draft.primary_motivation || draft.motivations || ''} onChange={value => { set('primary_motivation', value); set('motivations', value); }} multiline />
        <TextField label="Pain points" value={draft.pain_points || ''} onChange={value => set('pain_points', value)} multiline />
        <TextField label="Goals" value={draft.goals || ''} onChange={value => set('goals', value)} multiline />
        <TextField label="Buying behavior" value={draft.buying_behavior || ''} onChange={value => set('buying_behavior', value)} multiline />
        <TextField label="Decision-making style" value={draft.decision_style || ''} onChange={value => set('decision_style', value)} multiline />
        <TextField label="Typical online behavior" value={draft.online_behavior || ''} onChange={value => set('online_behavior', value)} multiline />
        <TextField label="Product expectations" value={draft.product_expectations || ''} onChange={value => set('product_expectations', value)} multiline />
        <TextField label="Reason for using this product" value={draft.goal_context || ''} onChange={value => set('goal_context', value)} multiline />
        <TextField label="Likelihood of becoming loyal" value={draft.loyalty_likelihood || ''} onChange={value => set('loyalty_likelihood', value)} multiline />
        <TextField label="What might make them abandon" value={draft.abandonment_triggers || draft.frustration_triggers?.join(', ') || ''} onChange={value => { set('abandonment_triggers', value); set('frustration_triggers', value.split(',').map(item => item.trim()).filter(Boolean)); }} multiline />
        <TextField label="Accessibility needs" value={draft.accessibility_needs?.join(', ') || ''} onChange={value => set('accessibility_needs', value.split(',').map(item => item.trim()).filter(Boolean))} multiline />
      </div>

      <TextField label="Complete backstory" value={draft.backstory || draft.biography || ''} onChange={value => { set('backstory', value); set('biography', value); }} multiline />

      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="persona-actions">
        <span>Saved persona fields are persisted before execution; unsupported fields must remain visible as a backend integration error, never silently fabricated.</span>
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save agent'} <Icon name="check" size={15} /></Button>
      </div>
    </form>
  </section>;
}
