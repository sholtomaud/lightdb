export interface RouteTarget {
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
}

export interface Route {
  path: string;
  component: string;
  beforeEnter?: (to: RouteTarget) => boolean | string | Promise<boolean | string>;
}

interface CompiledRoute extends Route {
  regex: RegExp;
  paramNames: string[];
}

export class Router {
  private static instance: Router | undefined;
  private routes: CompiledRoute[] = [];
  currentPath = '';

  constructor() {
    window.addEventListener('popstate', () => void this.handleRoute());
  }

  static getInstance(): Router {
    if (!Router.instance) {
      Router.instance = new Router();
    }
    return Router.instance;
  }

  private static baseUrl(): string {
    const base = (window as unknown as { BOBA_BASE_URL?: string }).BOBA_BASE_URL || '/';
    return base.endsWith('/') ? base : base + '/';
  }

  getAppPath(): string {
    const pathname = window.location.pathname;
    const base = Router.baseUrl();

    if (pathname.startsWith(base) && base.length > 1) {
      let appPath = pathname.substring(base.length);
      if (!appPath.startsWith('/')) appPath = '/' + appPath;
      return (appPath === '' ? '/' : appPath) + window.location.search;
    }
    return (pathname.startsWith('/') ? pathname : '/' + pathname) + window.location.search;
  }

  registerRoute(route: Route): void {
    const normalizedPath = route.path.startsWith('/') ? route.path : '/' + route.path;

    const paramNames: string[] = [];
    const regexSource = normalizedPath.replace(/:([^/]+)/g, (_, paramName: string) => {
      paramNames.push(paramName);
      return '([^\\/]+)';
    });

    this.routes.push({
      ...route,
      path: normalizedPath,
      regex: new RegExp(`^${regexSource}$`),
      paramNames,
    });
  }

  navigate(appPath: string): void {
    const pathAndQuery = appPath.startsWith('/') ? appPath : '/' + appPath;
    const [pathPart, queryString] = pathAndQuery.split('?');

    const publicPath = new URL(pathPart.substring(1), 'http://dummy' + Router.baseUrl())
      .pathname;
    const finalPath = publicPath + (queryString ? '?' + queryString : '');

    if (window.location.pathname + window.location.search !== finalPath) {
      window.history.pushState({}, '', finalPath);
    }
    void this.handleRoute();
  }

  async handleRoute(): Promise<void> {
    const appPathToMatch = this.getAppPath();
    const [pathPart, queryString] = appPathToMatch.split('?');

    const query = Object.fromEntries(new URLSearchParams(queryString || '').entries());
    const match = this.findRoute(pathPart);

    if (!match) {
      this.show404();
      return;
    }

    if (match.route.beforeEnter) {
      const to: RouteTarget = { path: pathPart, params: match.params, query };
      const guardResult = await match.route.beforeEnter(to);
      if (guardResult === false) {
        if (this.currentPath && this.currentPath !== appPathToMatch) {
          this.navigate(this.currentPath);
        }
        return;
      }
      if (typeof guardResult === 'string') {
        this.navigate(guardResult);
        return;
      }
    }

    this.currentPath = appPathToMatch;
    await this.loadComponent(match.route.component, match.params, query);
  }

  private findRoute(
    path: string
  ): { route: CompiledRoute; params: Record<string, string> } | null {
    for (const route of this.routes) {
      const match = path.match(route.regex);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, index) => {
          params[name] = decodeURIComponent(match[index + 1]);
        });
        return { route, params };
      }
    }
    return null;
  }

  private async loadComponent(
    tagName: string,
    params: Record<string, string> = {},
    query: Record<string, string> = {}
  ): Promise<void> {
    const outlet = document.querySelector('#router-outlet');
    if (!outlet) return;

    try {
      if (!customElements.get(tagName)) {
        await import(`../../components/${tagName}/${tagName}.ts`);
      }

      const element = document.createElement(tagName) as HTMLElement &
        Record<string, unknown>;
      Object.assign(element, params);
      element.params = params;
      element.query = query;

      outlet.innerHTML = '';
      outlet.appendChild(element);

      document.querySelectorAll('a[data-route]').forEach((a) => {
        a.classList.toggle('active', a.getAttribute('href') === this.currentPath);
      });
    } catch (error) {
      console.error(`Failed to load component: ${tagName}`, error);
      this.show404();
    }
  }

  private show404(): void {
    const outlet = document.querySelector('#router-outlet');
    if (!outlet) return;
    outlet.innerHTML = `
      <section class="panel">
        <h1>404</h1>
        <p class="muted">No such route.</p>
        <a class="btn" href="/" data-route>Back to start</a>
      </section>
    `;
  }
}
