import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { applyFontScale } from './services/storage';
import { initStorage } from './services/persistentStorage';
import { applySafeAreaInsets, initKeyboardHeightListener } from './utils/platform';
import './styles/variables.css';
import './styles/global.css';

applySafeAreaInsets();
initKeyboardHeightListener();

// Initialize persistent storage (restores Tauri store to localStorage),
// then apply settings and render.
initStorage().then(() => {
  applyFontScale();
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
