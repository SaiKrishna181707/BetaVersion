import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@centopus/ui/styles.css';
import './styles.css';
import './vision.css';
import './landing.css';
import './new-run-minimal.css';
import './population-minimal.css';
import './live-wait.css';
import './results-minimal.css';

const root = createRoot(document.getElementById('root')!);
root.render(<StrictMode><App /></StrictMode>);
