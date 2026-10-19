import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { applyFontScale } from './services/storage';
import { initStorage } from './services/persistentStorage';
import { initSecureTokens } from './services/secureTokens';
import { applySafeAreaInsets, initKeyboardHeightListener } from './utils/platform';
import { installExternalLinkHandler } from './utils/externalLinks';
import './styles/variables.css';
import './styles/global.css';
import './styles/herald.css';
import './styles/herald-setup.css';
import './styles/review.css';
import './styles/subagents.css';
import './styles/stuck.css';
import './styles/agents.css';
import './styles/babysit.css';
import { isOverlayWindow } from './services/overlayBridge';
import { HeraldOverlayApp } from './components/herald/HeraldOverlayApp';
import { heraldSetupStore } from './services/heraldSetup/setupStore';
import { initOfflineCache } from './services/offlineCache';

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
  // The offline cache (last session lists / conversations) loads alongside, so
  // the first frame can show cached sessions; never wait on it for long.
  const cacheReady = Promise.race([initOfflineCache(), new Promise<void>((r) => setTimeout(r, 400))]);
  Promise.all([initStorage().then(() => initSecureTokens()), cacheReady]).then(() => {
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
