import { useEffect, useState, type FormEvent } from 'react';
import { Button, Icon } from '@synthetic-beta/ui';
import type { EditablePersonaFields, SyntheticPersona } from '@synthetic-beta/contracts';

const options = {
  technical_ability: ['LOW', 'MEDIUM', 'HIGH'],
  product_familiarity: ['NEW', 'CATEGORY_FAMILIAR', 'POWER_USER'],
  patience: ['LOW', 'MEDIUM', 'HIGH'],
  reading_style: ['SCANNING', 'SELECTIVE', 'THOROUGH'],
  device_class: ['DESKTOP', 'TABLET', 'MOBILE_WEB'],
  price_sensitivity: ['LOW', 'MEDIUM', 'HIGH'],
  privacy_sensitivity: ['LOW', 'MEDIUM', 'HIGH'],
  income_band: ['LOW', 'MIDDLE', 'HIGH'],
  customer_loyalty: ['LOW', 'MEDIUM', 'HIGH'],
} as const;

export function PersonaEditor({ persona, saving, onSave }: {
  persona: SyntheticPersona;
  saving: boolean;
  onSave: (patch: Partial<EditablePersonaFields>) => Promise<void>;
}) {
  const [draft, setDraft] = useState(persona);
  const [error, setError] = useState('');
  useEffect(() => setDraft(persona), [persona]);
  const update = (field: keyof SyntheticPersona, value: unknown) => setDraft(current => ({ ...current, [field]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError('');
    try {
      await onSave({
        display_name: draft.display_name, age_band: draft.age_band, location_band: draft.location_band,
        income_band: draft.income_band, customer_loyalty: draft.customer_loyalty,
        occupation: draft.occupation, biography: draft.biography, primary_motivation: draft.primary_motivation,
        goal_context: draft.goal_context, technical_ability: draft.technical_ability,
        product_familiarity: draft.product_familiarity, patience: draft.patience,
        reading_style: draft.reading_style, device_class: draft.device_class,
        price_sensitivity: draft.price_sensitivity, privacy_sensitivity: draft.privacy_sensitivity,
        frustration_triggers: draft.frustration_triggers, accessibility_needs: draft.accessibility_needs,
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this profile.'); }
  };
  return <form className="persona-editor" onSubmit={event => void submit(event)}>
    <div className="persona-editor-heading"><div><span className="eyebrow">COMPLETE AGENT PROFILE</span><h2>{persona.display_name}</h2></div><span className="mono">{persona.persona_id}</span></div>
    <div className="persona-form-grid">
      {(['display_name', 'age_band', 'location_band', 'occupation'] as const).map(field => <label key={field}>{field.replaceAll('_', ' ')}<input value={draft[field] || ''} onChange={e => update(field, e.target.value)} required /></label>)}
      {Object.entries(options).map(([field, values]) => <label key={field}>{field.replaceAll('_', ' ')}<select value={String(draft[field as keyof SyntheticPersona] || '')} onChange={e => update(field as keyof SyntheticPersona, e.target.value)}>{values.map(value => <option key={value}>{value}</option>)}</select></label>)}
      <label className="wide">Biography<textarea value={draft.biography || ''} onChange={e => update('biography', e.target.value)} required /></label>
      <label className="wide">Primary motivation<textarea value={draft.primary_motivation || ''} onChange={e => update('primary_motivation', e.target.value)} required /></label>
      <label className="wide">Goal context<textarea value={draft.goal_context} onChange={e => update('goal_context', e.target.value)} required /></label>
      <label className="wide">Frustration triggers<input value={(draft.frustration_triggers || []).join(', ')} onChange={e => update('frustration_triggers', e.target.value.split(',').map(v => v.trim()).filter(Boolean))} /></label>
      <label className="wide">Accessibility needs<input value={(draft.accessibility_needs || []).join(', ')} onChange={e => update('accessibility_needs', e.target.value.split(',').map(v => v.trim()).filter(Boolean))} placeholder="Optional, comma separated" /></label>
    </div>
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <Button type="submit" disabled={saving}>{saving ? 'Saving profile...' : 'Save agent profile'} <Icon name="check" size={15} /></Button>
  </form>;
}
