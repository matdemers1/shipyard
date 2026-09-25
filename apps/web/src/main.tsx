import '@d3cloud/ui/tokens.css';
import '@d3cloud/ui/base.css';
import './styles.css';
import { readStyleNonce, setStyleNonce } from '@d3cloud/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// A strict style-src, when the server sends one, is honoured by the design system's dialogs.
const nonce = readStyleNonce();
if (nonce !== undefined) setStyleNonce(nonce);

const root = document.getElementById('root');
if (root === null) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
