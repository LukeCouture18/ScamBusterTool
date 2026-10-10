import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { runAutomatedTestSuite } from './utils/testSuite';

// Expose automated test runner on window for easy developer verification
if (typeof window !== 'undefined') {
  (window as Window & { runAutomatedTestSuite?: typeof runAutomatedTestSuite }).runAutomatedTestSuite = runAutomatedTestSuite;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
