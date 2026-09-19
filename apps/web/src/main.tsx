import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@synthetic-beta/ui/styles.css';
import './styles.css';
import './vision.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
