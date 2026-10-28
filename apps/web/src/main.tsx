import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import { Capacitor } from '@capacitor/core';
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
if (import.meta.env.PROD && !window.desktop && !Capacitor.isNativePlatform() && 'serviceWorker' in navigator && location.protocol.startsWith('http')) void navigator.serviceWorker.register('./sw.js');
