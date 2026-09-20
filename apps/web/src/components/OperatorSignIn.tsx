import { useState } from 'react';
import { accessToken, authConfigured, signIn, signOut } from '../lib/auth';

export function OperatorSignIn() {
  const [error, setError] = useState('');
  if (!authConfigured) return null;
  const signedIn = Boolean(accessToken());
  return <span>
    <button type="button" className="button button-secondary" onClick={() => {
      if (signedIn) signOut();
      else void signIn().catch(() => setError('Sign-in could not start. Please try again.'));
    }}>{signedIn ? 'Sign out' : 'Operator sign in'}</button>
    {error ? <span role="alert">{error}</span> : null}
  </span>;
}
