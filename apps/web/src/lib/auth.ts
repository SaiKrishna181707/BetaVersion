const TOKEN_KEY = 'centopus:auth:v1';
const VERIFIER_KEY = 'centopus:pkce-verifier';

export interface AuthTokens { access_token: string; id_token?: string; expires_at: number; }

const domain = (import.meta.env.VITE_COGNITO_DOMAIN as string | undefined)?.replace(/\/$/, '');
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
const redirectUri = import.meta.env.VITE_COGNITO_REDIRECT_URI as string | undefined;

export function authConfigured(): boolean { return Boolean(domain && clientId && redirectUri); }
export function tokens(): AuthTokens | null {
  try {
    const value = sessionStorage.getItem(TOKEN_KEY);
    if (!value) return null;
    const parsed = JSON.parse(value) as AuthTokens;
    if (!parsed.access_token || parsed.expires_at <= Date.now()) { sessionStorage.removeItem(TOKEN_KEY); return null; }
    return parsed;
  } catch { return null; }
}

function base64Url(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
}

async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export async function beginLogin(): Promise<void> {
  if (!authConfigured()) throw new Error('Cognito authentication is not configured for this deployment.');
  const random = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64Url(random);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const url = new URL(domain + '/oauth2/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId!);
  url.searchParams.set('redirect_uri', redirectUri!);
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', await challenge(verifier));
  window.location.assign(url.toString());
}

export async function finishLogin(code: string): Promise<void> {
  if (!authConfigured()) throw new Error('Cognito authentication is not configured for this deployment.');
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!verifier) throw new Error('The sign-in session expired. Start sign-in again.');
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId!, code, redirect_uri: redirectUri!, code_verifier: verifier });
  const response = await fetch(domain + '/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const payload = await response.json() as { access_token?: string; id_token?: string; expires_in?: number; error?: string };
  if (!response.ok || !payload.access_token) throw new Error(payload.error || 'Cognito sign-in failed.');
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ access_token: payload.access_token, id_token: payload.id_token, expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000 - 30000 }));
}

export function signOut(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  const url = new URL(domain + '/logout');
  url.searchParams.set('client_id', clientId!);
  url.searchParams.set('logout_uri', redirectUri!.replace(/\\/auth\\/callback$/, ''));
  window.location.assign(url.toString());
}

export function accessToken(): string | null { return tokens()?.access_token ?? null; }
