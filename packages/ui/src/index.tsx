import type { ButtonHTMLAttributes, ReactNode, SVGProps } from 'react';

const paths = {
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  chevron: 'm9 5 7 7-7 7',
  check: 'm5 12 4 4L19 6',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Zm-4 9 3 3 5-6',
  plus: 'M12 5v14M5 12h14',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  terminal: 'm5 6 5 6-5 6m8 0h6',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
  cursor: 'm5 3 14 10-7 1-3 7L5 3Zm7 11 5 6',
  activity: 'M2 12h5l3-8 4 16 3-8h5',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M13 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 11v6m0-10v.01',
  close: 'm6 6 12 12M6 18 18 6',
  file: 'M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 13h8M8 17h5',
  retry: 'M3 10a9 9 0 1 1 2 8M3 4v6h6',
  layers: 'm12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5',
} as const;

export type IconName = keyof typeof paths;
export function Icon({ name, size = 18, ...props }: SVGProps<SVGSVGElement> & { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]} /></svg>;
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return <a className="brand" href="#/" aria-label="Synthetic Beta home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>{!compact && <span>Synthetic<span className="brand-light">Beta</span></span>}</a>;
}

export function Button({ variant = 'primary', className = '', children, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  return <button type={type} className={`button button-${variant} ${className}`} {...props}>{children}</button>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warning' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Field({ id, label, hint, error, children, optional }: { id: string; label: string; hint?: string; error?: string; children: ReactNode; optional?: string }) {
  return <div className={`field${error ? ' field-invalid' : ''}`}><label htmlFor={id}>{label}{optional && <span className="field-optional">{optional}</span>}</label>{children}{hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}{error && <p className="field-error" id={`${id}-error`}>{error}</p>}</div>;
}

export function FieldsetTitle({ number, title, description }: { number: string; title: string; description: string }) {
  return <div className="fieldset-title"><span className="section-number mono">{number}</span><div><h2>{title}</h2><p>{description}</p></div></div>;
}
