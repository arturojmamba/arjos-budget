import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { LockGate } from './components/Lock.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LockGate><App /></LockGate>
  </React.StrictMode>,
);
