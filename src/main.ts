import './styles/global.css';
import './components/app-nav/app-nav.ts';
import './components/home-page/home-page.ts';
import './components/db-page/db-page.ts';
import './components/send-page/send-page.ts';
import './components/receive-page/receive-page.ts';

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

function getInitialAppPath(): string {
  const base = (window as unknown as { BOBA_BASE_URL: string }).BOBA_BASE_URL;
  const normalized = base.endsWith('/') ? base : base + '/';
  const pathname = window.location.pathname;

  if (pathname.startsWith(normalized) && normalized.length > 1) {
    let appPath = pathname.substring(normalized.length);
    if (!appPath.startsWith('/')) appPath = '/' + appPath;
    return appPath === '' ? '/' : appPath;
  }
  return pathname.startsWith('/') ? pathname : '/' + pathname;
}

const router = Router.getInstance();
router.registerRoute({ path: '/', component: 'home-page' });
router.registerRoute({ path: '/db', component: 'db-page' });
router.registerRoute({ path: '/send', component: 'send-page' });
router.registerRoute({ path: '/receive', component: 'receive-page' });

// Intercept in-app links so the router handles them without a page load.
document.addEventListener('click', (event) => {
  const anchor = (event.target as HTMLElement | null)?.closest('a[data-route]');
  if (!anchor) return;

  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('http')) return;

  event.preventDefault();
  router.navigate(href);
});

// Open the local database before the first route paints.
void initDb().catch((error: Error) => {
  console.error('Failed to open local database', error);
});

router.navigate(getInitialAppPath());

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
        // Deploys land while tabs are open; check rather than wait for the
        // browser's own 24-hour cadence.
        void registration.update();
      })
      .catch((error) => {
        console.warn('Service worker registration failed; app will not work offline', error);
      });
  });

  // A new worker taking control means the assets under us just changed, so the
  // page must reload to match. But on a first visit clients.claim() also fires
  // this with nothing stale to escape -- reloading there is a spurious refresh
  // for every new visitor. Only an *replacement* controller warrants it.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
}
