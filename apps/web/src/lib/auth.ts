const domain = (import.meta.env.VITE_COGNITO_DOMAIN as string | undefined)?.replace(/\/$/, '');
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined;
const key = 'centopus:operator';
export const authConfigured = Boolean(domain && clientId);

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function accessToken(): string | null {
  try {
    const session = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { token: string; expires: number } | null;
    return session && session.expires > Date.now() ? session.token : null;
  } catch { return null; }
}

export async function signIn() {
  if (!authConfigured) throw new Error('Operator sign-in is not configured.');
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(`${key}:pkce`, JSON.stringify({ verifier, state, hash: location.hash }));
  const query = new URLSearchParams({ response_type: 'code', client_id: clientId!, redirect_uri: `${location.origin}/`,
    scope: 'openid email', state, code_challenge: challenge, code_challenge_method: 'S256' });
  location.assign(`${domain}/oauth2/authorize?${query}`);
}

export async function finishSignIn() {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return;
  if (!authConfigured) throw new Error('Unexpected sign-in callback.');
  const pending = JSON.parse(sessionStorage.getItem(`${key}:pkce`) ?? 'null') as { verifier: string; state: string; hash: string } | null;
  sessionStorage.removeItem(`${key}:pkce`);
  history.replaceState(null, '', `/${pending?.hash?.startsWith('#/') ? pending.hash : '#/'}`);
  if (!pending || params.get('state') !== pending.state) throw new Error('Sign-in state did not match.');
  if (params.has('error')) throw new Error('Operator sign-in was declined.');
  const response = await fetch(`${domain}/oauth2/token`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId!,
      redirect_uri: `${location.origin}/`, code: params.get('code')!, code_verifier: pending.verifier }) });
  if (!response.ok) throw new Error('Operator sign-in failed.');
  const tokens = await response.json() as { access_token?: string; expires_in?: number };
  if (!tokens.access_token || !tokens.expires_in) throw new Error('Sign-in returned no access token.');
  sessionStorage.setItem(key, JSON.stringify({ token: tokens.access_token, expires: Date.now() + tokens.expires_in * 1000 - 30000 }));
}

export function signOut() {
  sessionStorage.removeItem(key);
  location.assign(`${domain}/logout?${new URLSearchParams({ client_id: clientId!, logout_uri: `${location.origin}/` })}`);
}
