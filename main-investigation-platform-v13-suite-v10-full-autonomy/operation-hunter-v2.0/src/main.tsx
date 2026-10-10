import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { HunterApp } from './v1/HunterApp';
import './index.css';

/** The v2.0 experience (built on the v1 shell) is the default; the v0.x analyst views stay available at #/classic. */
function Root() {
  const isClassic = () => /^#\/?classic/.test(window.location.hash);
  const [classic, setClassic] = useState(isClassic());
  useEffect(() => {
    const onHash = () => setClassic(isClassic());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => { document.body.classList.toggle('hx-body', !classic); }, [classic]);
  return classic ? <App key="classic" /> : <HunterApp />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
