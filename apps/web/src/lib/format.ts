import type { EvidenceRate } from '@synthetic-beta/contracts';

/** A rate with an empty denominator reads as "no data", never as 0%. */
export function formatRate(rate: EvidenceRate): string {
  return rate.percentage === null
    ? `no data (0/${rate.denominator})`
    : `${rate.percentage}% (${rate.numerator}/${rate.denominator})`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'not recorded';
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/** Renders the recorded instant, or says so plainly when nothing was recorded. */
export function formatInstant(iso: string | null): string {
  if (iso === null) return 'not recorded';
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : iso;
}

/** References are local paths or s3:// URIs; only an http(s) reference can be opened directly. */
export function isOpenableRef(ref: string | null): ref is string {
  return ref !== null && /^https?:\/\//.test(ref);
}