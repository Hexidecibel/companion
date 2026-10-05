import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { applyFontScale } from './services/storage';
import { initStorage } from './services/persistentStorage';
import { initSecureTokens } from './services/secureTokens';
import { applySafeAreaInsets, initKeyboardHeightListener, installExternalLinkHandler } from './utils/platform';
import './styles/variables.css';
import './styles/global.css';
import './styles/herald.css';
import './styles/herald-setup.css';
import './styles/review.css';
import './styles/stuck.css';
import { isOverlayWindow } from './services/overlayBridge';
import { HeraldOverlayApp } from './components/herald/HeraldOverlayApp';
import { heraldSetupStore } from './services/heraldSetup/setupStore';

if (isOverlayWindow()) {
  // The desktop app's floating orb window: just the orb, no app.
  document.documentElement.classList.add('herald-overlay-root');
  ReactDOM.createRoot(document.getElementById('root')!).render(<HeraldOverlayApp />);
} else {
  startApp();
}

function startApp(): void {
  applySafeAreaInsets();
  initKeyboardHeightListener();
  installExternalLinkHandler();

  // Initialize persistent storage (restores Tauri store to localStorage),
  // then apply settings and render.
  // Then the mobile apps read the device tokens from the Keystore / Keychain
  // (and move any left in app storage there): secureTokens.ts.
  initStorage().then(() => initSecureTokens()).then(() => {
    applyFontScale();
    // Herald setup (profile, floating orb) was read before the restore.
    heraldSetupStore.reload();
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  });
}
