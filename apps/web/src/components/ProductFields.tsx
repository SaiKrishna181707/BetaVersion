import type { ConfigurationErrors, RunConfiguration } from '@centopus/contracts';
import { Field, FieldsetTitle } from '@centopus/ui';

export interface RunFieldsProps {
  configuration: RunConfiguration;
  errors: ConfigurationErrors;
  update: <K extends keyof RunConfiguration>(key: K, value: RunConfiguration[K]) => void;
}

export function ProductFields({ configuration, errors, update }: RunFieldsProps) {
  const accessibility = (key: keyof RunConfiguration) => ({
    'aria-invalid': Boolean(errors[key]),
    'aria-describedby': `${key}-hint${errors[key] ? ` ${key}-error` : ''}`,
  });
  return <section className="form-section"><FieldsetTitle number="01" title="The product" description="Point your synthetic users at a product you’re authorized to test." /><div className="fields-stack">
    <Field id="target_url" label="Target URL" hint="Use an owned demo or staging environment. Keep credentials out of this form." error={errors.target_url}><div className="url-input"><span aria-hidden="true">↗</span><input id="target_url" type="url" placeholder="http://localhost:4174" value={configuration.target_url} onChange={e => update('target_url', e.target.value)} autoComplete="off" maxLength={2048} required {...accessibility('target_url')} /></div></Field>
    <Field id="product_description" label="What does your product do?" hint="Give the agents enough context to understand the product." error={errors.product_description}><textarea id="product_description" placeholder="A project management tool that helps small teams plan launches and collaborate in one workspace." value={configuration.product_description} onChange={e => update('product_description', e.target.value)} maxLength={2000} required {...accessibility('product_description')} /></Field>
    <Field id="target_audience" label="Who is it for?" hint="Describe their background, familiarity, and what brings them here." error={errors.target_audience}><input id="target_audience" placeholder="Early-stage founders trying a project tool for the first time" value={configuration.target_audience} onChange={e => update('target_audience', e.target.value)} maxLength={1000} required {...accessibility('target_audience')} /></Field>
    <Field id="objective" label="One task to accomplish" optional="One objective per run" hint="Describe a verifiable outcome. Let the agents choose how to get there." error={errors.objective}><textarea id="objective" placeholder="Create a project and invite a teammate to collaborate." value={configuration.objective} onChange={e => update('objective', e.target.value)} maxLength={1000} required {...accessibility('objective')} /></Field>
  </div></section>;
}
