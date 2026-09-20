import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@synthetic-beta/ui/styles.css';
import './styles.css';
import './vision.css';

const root = createRoot(document.getElementById('root')!);
root.render(<StrictMode><App /></StrictMode>);
