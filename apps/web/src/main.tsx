import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { finishSignIn } from './lib/auth';
import { App } from './App';
import '@synthetic-beta/ui/styles.css';
import './styles.css';
import './vision.css';

const root = createRoot(document.getElementById('root')!);
void finishSignIn().then(() => root.render(<StrictMode><App /></StrictMode>))
  .catch(() => root.render(<main><h1>Sign-in failed</h1><p>Please return home and sign in again.</p><a href="/">Centopus home</a></main>));
