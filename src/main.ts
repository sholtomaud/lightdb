import './styles/global.css';
import './components/sync-page/sync-page.ts';

import { Router } from './core/router/router.ts';
import { initDb } from './store/app-store.ts';

// GitHub Pages serves from /<repo>/, so derive the base before routing.
const isGitHubPages = window.location.hostname.endsWith('.github.io');
const pathSegments = window.location.pathname.split('/');
const repoName =
  isGitHubPages && pathSegments.length > 1 && pathSegments[1] ? pathSegments[1] : null;
(window as unknown as { BOBA_BASE_URL: string }).BOBA_BASE_URL = repoName
  ? `/${repoName}/`
  : '/';

// One page: the optical link and the database it feeds, side by side. The
// router stays because Boba resolves components through it and it keeps the
// GitHub Pages base-path handling in one place.
const router = Router.getInstance();
router.registerRoute({ path: '/', component: 'sync-page' });

void initDb().catch((error: Error) => {
  console.error('Failed to open local database', error);
});

router.navigate('/');

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const base = (window as unknown as { BOBA_BASE_URL: string }).BOBA_BASE_URL;

    navigator.serviceWorker
      .register(`${base}sw.js`, {
        scope: base,
        // Never let the HTTP cache hand us a stale worker. A bad cached worker
        // is the one failure that cannot fix itself.
        updateViaCache: 'none',
      })
      .then((registration) => {
        void registration.update();
      })
      .catch((error) => {
        console.warn('Service worker registration failed; app will not work offline', error);
      });
  });

  // A new worker taking control means the assets under us just changed, so the
  // page must reload to match. But on a first visit clients.claim() also fires
  // this with nothing stale to escape -- reloading there is a spurious refresh
  // for every new visitor. Only a *replacement* controller warrants it.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
}
