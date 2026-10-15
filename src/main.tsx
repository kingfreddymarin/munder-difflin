import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { findBridge } from './data/bridge';
import './index.css';

// The macOS desktop window has no title bar ('hiddenInset'): the traffic lights float over the top-left
// corner and the app provides its own drag regions. `desktop-mac:` styles key off this attribute.
if (findBridge() && /Mac/i.test(navigator.userAgent)) document.documentElement.dataset.desktop = 'mac';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
