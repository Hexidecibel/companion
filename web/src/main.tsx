import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { applyFontScale } from './services/storage';
import './styles/variables.css';
import './styles/global.css';

applyFontScale();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
