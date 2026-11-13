import React, {
  Suspense,
  startTransition,
  use,
  useCallback,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
  useSyncExternalStore,
  useTransition,
  type ComponentType,
} from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import {
  createRouterFacade,
  createPageNavigationEngine,
  documentBaseUrl,
  idleNavigationState,
  navigationStateFor,
  isAbortError,
  isCallSiteActionError,
  refreshPage,
  normalizePageUrl,
  abortError,
  abortedVisitResolvesUndefined,
  hasPageBoundaries,
  pageBoundarySlots,
  showTerminalPageError,
  type BoundaryManifest,
  type PageNavigationResource,
  type PageNavigationResult,
  type NavigationState,
  type VoidRouter,
  type RuntimeVoidRouter,
} from 'void/pages-client';
import type { CacheForResult, LinkPrefetchValue } from 'void/pages-prefetch';
import type { PageObject } from 'void/pages-protocol';
import { setActionRouter } from './action.ts';
import {
  ErrorsContext,
  NavigationContext,
  ParamsContext,
  RouterContext,
  SharedContext,
} from './context.ts';
import { DEFERRED_SHELL_END_ID } from './deferred-shell.ts';
import { PageErrorBoundary } from './PageErrorBoundary.tsx';

// oxlint-disable-next-line no-explicit-any -- component props are narrowed by generated route types
type ComponentModule = { default: ComponentType<any> };
type ReactPageData = PageObject;
type ReactPageComponent = ComponentType<Record<string, unknown>>;
type ReactLayoutComponent = ComponentType<{ children?: React.ReactNode }>;

export type ReactPagesConfig = Readonly<{
  boundaryManifest?: BoundaryManifest;
  dev?: boolean;
  components: Record<string, () => Promise<ComponentModule>>;
  layoutTree: Record<string, Array<string>>;
  routeMeta: Record<string, { island?: boolean; prerender?: boolean }>;
  /** Page id for a decoded pathname. */
  matchRoute(path: string): string | null;
  staticPageData: boolean;
  staticPageDataFastPath: boolean;
  viewTransitions: boolean;
  prefetchHoverDelay: number;
  prefetchDefaultCacheFor: CacheForResult;
  prefetchDefaultStrategy?: LinkPrefetchValue;
  cacheVisitedPageData?: boolean;
  /** Show this fallback for client visits whose destination remains pending at the next paint. */
  navigationFallback?: ComponentType<{ initialPageData: PageObject }>;
}>;

export type ReactPagesClient = Readonly<{
  router: VoidRouter;
}>;

type DeferredResource = Promise<unknown>;

type DeferredResourceState =
  | {
      status: 'pending';
      resolve(value: unknown): void;
      reject(error: unknown): void;
    }
  | { status: 'resolved' | 'rejected' };

type ReactPageResource = PageNavigationResource & {
  shell: Promise<PageNavigationResult | undefined>;
};

type VisitSettler = {
  resolve(pageData: ReactPageData | undefined): void;
  reject(error: unknown): void;
  abort(): void;
};

type AppState = {
  resource: ReactPageResource;
  rollbackResource: ReactPageResource | null;
  navigation: NavigationState;
  routeUrl: string;
  pendingId: number | null;
};

type AppAction =
  | {
      type: 'begin';
      resource: ReactPageResource;
      navigation: NavigationState;
    }
  | { type: 'reveal'; resource: ReactPageResource }
  | { type: 'finish'; resource: ReactPageResource; location: string }
  | { type: 'fail'; resource: ReactPageResource; location: string }
  | { type: 'abandon'; resource: ReactPageResource; location: string }
  | { type: 'location'; location: string };

/**
 * The visit `schedule` began last, and what is still owed to it. `schedule` ends the previous
 * visit before it begins the next, so one record is enough. Every method takes the id of the
 * visit the caller is working for and does nothing for any other visit.
 */
class ActiveVisit {
  /**
   * The resource of the visit begun last. It stays after that visit ends: an uncaught render
   * error names it as the page that failed.
   */
  resource: ReactPageResource | null = null;
  private pending = false;
  private settler: VisitSettler | null = null;
  private viewTransitionWaiter: (() => void) | null = null;
  // With a navigation fallback, React reads a shell that stays pending until the browser has
  // captured the screen the view transition animates from. The gate settles that shell: with the
  // destination once the capture is done, or with nothing when the visit ends first.
  private viewTransitionGate: ((reveal: boolean) => void) | null = null;

  /** The id of the visit that is still pending, or null. */
  get id(): number | null {
    return this.pending && this.resource ? this.resource.id : null;
  }

  isActive(id: number): boolean {
    return this.id === id;
  }

  private owns(id: number): boolean {
    return this.resource !== null && this.resource.id === id;
  }

  begin(
    resource: ReactPageResource,
    settler: VisitSettler,
    viewTransitionGate: ((reveal: boolean) => void) | null,
  ): void {
    this.resource = resource;
    this.settler = settler;
    this.viewTransitionWaiter = null;
    this.viewTransitionGate = viewTransitionGate;
    this.pending = true;
  }

  /** Hands over the visit's settler, once. A visit that resolved on its data has none left. */
  takeSettler(id: number): VisitSettler | undefined {
    if (!this.owns(id) || !this.settler) {
      return undefined;
    }
    const settler = this.settler;
    this.settler = null;
    return settler;
  }

  /** Keeps the browser's view transition waiting until the visit releases it. */
  holdViewTransition(id: number, resolve: () => void): void {
    if (this.owns(id)) {
      this.viewTransitionWaiter = resolve;
    }
  }

  settleViewTransitionGate(id: number, reveal: boolean): void {
    const settle = this.viewTransitionGate;
    if (this.owns(id) && settle) {
      this.viewTransitionGate = null;
      settle(reveal);
    }
  }

  /**
   * Ends the visit's part in a view transition. A destination still waiting for the browser's
   * capture is dropped, and a transition waiting for React's commit continues.
   */
  releaseViewTransition(id: number): void {
    this.settleViewTransitionGate(id, false);
    const resolveViewTransition = this.viewTransitionWaiter;
    if (this.owns(id) && resolveViewTransition) {
      this.viewTransitionWaiter = null;
      resolveViewTransition();
    }
  }

  /** Marks the visit as no longer pending. Returns whether it was the pending visit. */
  end(id: number): boolean {
    if (!this.isActive(id)) {
      return false;
    }
    this.pending = false;
    return true;
  }

  reset(): void {
    this.resource = null;
    this.pending = false;
    this.settler = null;
    this.viewTransitionWaiter = null;
    this.viewTransitionGate = null;
  }
}

const deferredState = new WeakMap<DeferredResource, DeferredResourceState>();
const activeVisit = new ActiveVisit();
let committedResources = new WeakSet<ReactPageResource>();
const EMPTY_PARAMS: Record<string, string> = {};

// The URL the prerendered HTML was rendered with, while it differs from the browser URL. The
// hydration commit clears it before effects run, so effects and later renders read the browser URL.
let prerenderedUrl: string | null = null;
let scheduleVisit:
  | ((resource: PageNavigationResource) => Promise<ReactPageData | undefined>)
  | null = null;

function createDeferredResource(): DeferredResource {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  deferredState.set(promise, { status: 'pending', resolve, reject });
  return promise;
}

function resolveDeferredResource(ref: unknown, value: unknown): unknown {
  const state = deferredState.get(ref as DeferredResource);
  if (state?.status === 'pending') {
    state.resolve(value);
    deferredState.set(ref as DeferredResource, { status: 'resolved' });
  }
  return ref;
}

function rejectDeferredResource(ref: unknown, error: string): unknown {
  const state = deferredState.get(ref as DeferredResource);
  if (state?.status === 'pending') {
    state.reject(new Error(error));
    deferredState.set(ref as DeferredResource, { status: 'rejected' });
  }
  return ref;
}

function isDeferredResourceLoading(ref: unknown): boolean {
  return deferredState.get(ref as DeferredResource)?.status === 'pending';
}

function currentUrl(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

/** Page data holds a decoded path. Compare it with browser URLs in their encoded form. */
function encodedPageUrl(url: string): string {
  if (!url) {
    return url;
  }
  const parsed = new URL(url, documentBaseUrl());
  return parsed.pathname + parsed.search;
}

/** Static hosts serve one page at `/a`, `/a/`, `/a.html` and `/a/index.html`. */
function staticPagePath(pathname: string): string {
  let path = pathname;
  if (path.endsWith('/index.html')) {
    path = path.slice(0, -'index.html'.length);
  } else if (path.endsWith('.html')) {
    path = path.slice(0, -'.html'.length);
  }
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Static page data serves every query of a path, so its url has no query. Returns the query of
 * fetchUrl when the page data is such data for its path, or null.
 */
function staticVisitQuery(pageUrl: string, fetchUrl: string): string | null {
  if (!pageUrl || pageUrl.includes('?')) {
    return null;
  }
  const queryStart = fetchUrl.indexOf('?');
  const fetchPath = queryStart === -1 ? fetchUrl : fetchUrl.slice(0, queryStart);
  if (staticPagePath(fetchPath) !== staticPagePath(pageUrl)) {
    return null;
  }
  return queryStart === -1 ? '' : fetchUrl.slice(queryStart);
}

/**
 * The URL prerendered HTML was rendered with, when it lacks the visitor's query, or null.
 */
function prerenderedRouteUrl(pageData: ReactPageData): string | null {
  const pageUrl = encodedPageUrl(pageData.url);
  const query = staticVisitQuery(pageUrl, window.location.pathname + window.location.search);
  return query ? pageUrl + window.location.hash : null;
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'begin':
      return {
        resource: state.resource,
        rollbackResource: state.rollbackResource || state.resource,
        pendingId: action.resource.id,
        routeUrl: state.routeUrl,
        navigation: action.navigation,
      };
    case 'reveal':
      if (state.pendingId !== action.resource.id) {
        return state;
      }
      return {
        ...state,
        resource: action.resource,
      };
    case 'finish':
      if (state.pendingId !== action.resource.id) {
        return state;
      }
      return {
        resource: action.resource,
        rollbackResource: null,
        pendingId: null,
        routeUrl: action.location,
        navigation: idleNavigationState(),
      };
    case 'fail':
      if (state.pendingId !== action.resource.id) {
        return state;
      }
      return {
        ...state,
        resource: state.rollbackResource || state.resource,
        rollbackResource: null,
        pendingId: null,
        routeUrl: action.location,
        navigation: idleNavigationState(),
      };
    case 'abandon':
      if (state.pendingId !== action.resource.id) {
        return state;
      }
      return {
        resource: state.rollbackResource || state.resource,
        rollbackResource: null,
        pendingId: null,
        routeUrl: action.location,
        navigation: idleNavigationState(),
      };
    case 'location':
      return { ...state, routeUrl: action.location };
  }
}

function createRouter(
  engine: Awaited<ReturnType<typeof createPageNavigationEngine>>,
): RuntimeVoidRouter {
  const router: RuntimeVoidRouter = {
    get url() {
      return new URL(currentUrl(), documentBaseUrl());
    },
    get path() {
      return this.url.pathname;
    },
    get query() {
      return this.url.searchParams;
    },
    get params() {
      return {};
    },
    visit(url, options = {}) {
      if (!scheduleVisit) {
        return Promise.reject(new Error('router.visit() called before router initialized'));
      }
      return engine.visit(normalizePageUrl(url), options, scheduleVisit);
    },
    refresh(options = {}) {
      return refreshPage(router, options);
    },
    prefetch(url, options = {}) {
      return engine.prefetch(normalizePageUrl(url), options);
    },
    flush(url) {
      engine.flush(normalizePageUrl(url));
    },
    flushAll() {
      engine.flushAll();
    },
  };
  return router;
}

function RouteResource({
  resource,
  onCommit,
  config,
  onFailure,
}: {
  resource: ReactPageResource;
  onCommit(resource: ReactPageResource, result: PageNavigationResult): void;
  config: ReactPagesConfig;
  onFailure(url: string): void;
}): React.ReactNode {
  const result = use(resource.shell);
  const outerRouter = React.useContext(RouterContext);
  useLayoutEffect(() => {
    if (result) {
      onCommit(resource, result);
    }
  }, [onCommit, resource, result]);

  const pageData = result?.pageData as ReactPageData | undefined;
  const pageDataUrl = pageData?.url ?? '';
  const routeParams = pageData?.params ?? EMPTY_PARAMS;
  const routeRouter = useMemo(() => {
    const pageUrl = encodedPageUrl(pageDataUrl);
    return createRouterFacade(
      outerRouter!,
      () => {
        const outerUrl = outerRouter!.url;
        const outerPath = outerUrl.pathname + outerUrl.search;
        if (outerPath === pageUrl) {
          return outerPath + outerUrl.hash;
        }
        // Keep the query of a visit that loaded static page data. The outer URL keeps the hash
        // current after a same-page hash visit; during a reveal it still names the old page.
        const query = staticVisitQuery(pageUrl, resource.fetchUrl);
        if (query !== null) {
          return (
            pageUrl + query + (outerPath === resource.fetchUrl ? outerUrl.hash : resource.hash)
          );
        }
        return pageUrl + resource.hash;
      },
      () => routeParams,
    );
  }, [outerRouter, pageDataUrl, resource.fetchUrl, resource.hash, routeParams]);

  // Hooks above run on every render, so a resource with no result keeps the hook count.
  if (!result || !pageData) {
    return null;
  }

  const PageComponent = result.component as ReactPageComponent;
  const boundaries = pageBoundarySlots(
    config.boundaryManifest,
    pageData.component,
    config.components,
  );
  const wrap = (element: React.ReactNode, depth: number) =>
    boundaries
      .filter((b) => b.depth === depth)
      .reduce(
        (child, boundary) =>
          React.createElement(
            PageErrorBoundary,
            {
              boundary,
              key: boundary.key,
              generation: resource.id,
              dev: config.dev,
              onFailure: () => {
                onFailure(resource.fetchUrl);
                onFailure(resource.destination());
              },
            },
            child,
          ),
        element,
      );
  let element: React.ReactNode = React.createElement(PageComponent, pageData.props);
  for (let i = result.layouts.length - 1; i >= 0; i--) {
    const Layout = result.layouts[i] as ReactLayoutComponent;
    element = React.createElement(Layout, null, wrap(element, i + 1));
  }
  element = wrap(element, 0);

  return React.createElement(
    RouterContext.Provider,
    { value: routeRouter },
    React.createElement(
      ParamsContext.Provider,
      { value: routeParams },
      React.createElement(
        SharedContext.Provider,
        { value: pageData.shared ?? {} },
        React.createElement(ErrorsContext.Provider, { value: pageData.errors ?? {} }, element),
      ),
    ),
  );
}

class RouteRenderBoundary extends React.Component<
  {
    resourceId: number;
    pending: boolean;
    onError(error: unknown): void;
    children?: React.ReactNode;
  },
  { resourceId: number; failure: { error: unknown } | null }
> {
  state: { resourceId: number; failure: { error: unknown } | null } = {
    resourceId: this.props.resourceId,
    failure: null,
  };

  static getDerivedStateFromProps(
    { resourceId }: { resourceId: number },
    state: { resourceId: number },
  ) {
    return resourceId === state.resourceId ? null : { resourceId, failure: null };
  }

  static getDerivedStateFromError(error: unknown) {
    return { failure: { error } };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    const failure = this.state.failure;
    if (failure && !this.props.pending) {
      throw failure.error;
    }
    return failure ? null : this.props.children;
  }
}

function startViewTransition(resource: ReactPageResource, reveal: () => void): void {
  if (!resource.viewTransition || typeof document.startViewTransition !== 'function') {
    reveal();
    return;
  }

  let resolveViewTransition!: () => void;
  const readyForCapture = new Promise<void>((resolve) => {
    resolveViewTransition = resolve;
  });
  activeVisit.holdViewTransition(resource.id, resolveViewTransition);
  document.startViewTransition(() => {
    reveal();
    return readyForCapture;
  });
}

function App({
  config,
  engine,
  router,
  navigationFallback: NavigationFallback,
}: {
  config: ReactPagesConfig;
  engine: Awaited<ReturnType<typeof createPageNavigationEngine>>;
  router: RuntimeVoidRouter;
  navigationFallback?: ComponentType<{ initialPageData: PageObject }>;
}): React.ReactNode {
  const initialPageData = engine.initialPageData as ReactPageData;
  const [hydrated, setHydrated] = useState(prerenderedUrl === null);
  const initialResource = useMemo<ReactPageResource>(
    () => ({
      id: 0,
      url: initialPageData.url || currentUrl(),
      fetchUrl: window.location.pathname + window.location.search,
      hash: window.location.hash,
      method: 'GET',
      options: {},
      viewTransition: false,
      shell: Promise.resolve({
        pageData: initialPageData,
        component: engine.initialComponent,
        layouts: engine.initialLayouts,
      }),
      destination: currentUrl,
      abort() {},
      async commit() {
        engine.commitInitialRender();
        document.getElementById('app')!.setAttribute('data-hydrated', 'true');
        if (prerenderedUrl !== null) {
          prerenderedUrl = null;
          // A transition waits for Suspense boundaries that are still dehydrated, where an urgent
          // update would replace their server HTML with the fallback. Those boundaries hydrate
          // with the browser URL, so one that renders the query falls back to a client render.
          React.startTransition(() => setHydrated(true));
        }
        return true;
      },
      dispose() {},
    }),
    [engine, initialPageData],
  );
  const [state, dispatch] = useReducer(appReducer, {
    resource: initialResource,
    rollbackResource: null,
    pendingId: null,
    routeUrl: currentUrl(),
    navigation: idleNavigationState(),
  });
  const [isTransitionPending, startTransition] = useTransition();
  const [navigationStore] = useState(() => {
    let snapshot = idleNavigationState();
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set(navigation: NavigationState) {
        snapshot = navigation;
        for (const listener of listeners) {
          listener();
        }
      },
    };
  });
  const lastNavigation = useSyncExternalStore(
    navigationStore.subscribe,
    navigationStore.getSnapshot,
    navigationStore.getSnapshot,
  );

  // A failed batched visit can restore the same resource identities. Its state
  // commit still acknowledges that the abandoned render has left the tree.
  useLayoutEffect(() => {
    engine.releaseRetiredResources(
      new Set([state.resource.id, ...(state.rollbackResource ? [state.rollbackResource.id] : [])]),
    );
  }, [engine, state]);

  const finishNavigation = useCallback(
    (resource: ReactPageResource, result: PageNavigationResult) => {
      if (committedResources.has(resource)) {
        return;
      }
      committedResources.add(resource);
      resource
        .commit()
        .then((committed) => {
          activeVisit.releaseViewTransition(resource.id);
          const visitSettler = activeVisit.takeSettler(resource.id);
          if (visitSettler) {
            if (committed) {
              visitSettler.resolve(result.pageData);
            } else if (resource.method === 'GET') {
              // A newer visit committed first. Settle like any abandoned visit. The method alone
              // decides: a visit that resolves on its shell has dropped its settler by now.
              visitSettler.resolve(undefined);
            } else {
              visitSettler.reject(abortError());
            }
          }
          const active = activeVisit.end(resource.id);
          if (committed) {
            dispatch({ type: 'finish', resource, location: currentUrl() });
          } else if (active) {
            dispatch({ type: 'abandon', resource, location: currentUrl() });
          }
        })
        .catch((error) => {
          // The history write failed, so the address bar still shows the committed page.
          // End this visit and show that page again; a newer visit keeps its own state.
          activeVisit.releaseViewTransition(resource.id);
          const visitSettler = activeVisit.takeSettler(resource.id);
          if (visitSettler) {
            visitSettler.reject(error);
          } else {
            // A data-ready visit has already settled with its result.
            reportError(error);
          }
          activeVisit.end(resource.id);
          dispatch({ type: 'fail', resource, location: currentUrl() });
        });
    },
    [],
  );

  const schedule = useCallback(
    (resource: PageNavigationResource) => {
      const supersededId = activeVisit.id;
      if (supersededId !== null) {
        activeVisit.takeSettler(supersededId)?.abort();
        activeVisit.releaseViewTransition(supersededId);
      }
      const prepared = resource as ReactPageResource;
      const options = prepared.options;
      const resolveOnData =
        prepared.options.resolveOn === 'data' || prepared.options._resolveOnShell;
      let resolveVisit!: (pageData: ReactPageData | undefined) => void;
      let rejectVisit!: (error: unknown) => void;
      const pagePromise = new Promise<ReactPageData | undefined>((resolve, reject) => {
        resolveVisit = resolve;
        rejectVisit = reject;
      });

      const shell = prepared.shell.then(
        (result) => {
          if (!result) {
            activeVisit.releaseViewTransition(prepared.id);
            activeVisit.takeSettler(prepared.id);
            activeVisit.end(prepared.id);
            // The browser is leaving or downloading a file: keep the current page.
            dispatch({ type: 'abandon', resource: prepared, location: currentUrl() });
            resolveVisit(undefined);
          } else if (resolveOnData) {
            activeVisit.takeSettler(prepared.id);
            resolveVisit(result.pageData);
          }
          return result;
        },
        (error) => {
          activeVisit.releaseViewTransition(prepared.id);
          activeVisit.takeSettler(prepared.id);
          // Public data completion keeps the usual cancellation behavior for GETs.
          const abortingGetVisit =
            isAbortError(error) && abortedVisitResolvesUndefined(prepared.method, prepared.options);
          if (abortingGetVisit) {
            resolveVisit(undefined);
          } else {
            rejectVisit(error);
          }
          activeVisit.end(prepared.id);
          if (
            NavigationFallback ||
            resolveOnData ||
            isAbortError(error) ||
            isCallSiteActionError(error)
          ) {
            dispatch({ type: 'abandon', resource: prepared, location: currentUrl() });
            return undefined;
          }
          dispatch({ type: 'fail', resource: prepared, location: currentUrl() });
          throw error;
        },
      );
      // The fallback is on screen while the shell loads, so a view transition has to capture it
      // before React renders the destination. React reads a shell that waits for that capture.
      const gated =
        Boolean(NavigationFallback) &&
        prepared.viewTransition &&
        typeof document.startViewTransition === 'function';
      let settleCapture: ((reveal: boolean) => void) | null = null;
      const captured = gated
        ? new Promise<boolean>((resolve) => {
            settleCapture = resolve;
          })
        : null;
      const next: ReactPageResource = {
        ...prepared,
        shell: captured
          ? shell.then(
              (result) => result && captured.then((reveal) => (reveal ? result : undefined)),
            )
          : shell,
      };
      const navigation = navigationStateFor(next.fetchUrl + next.hash, next.method);
      navigationStore.set(navigation);

      activeVisit.begin(
        next,
        {
          resolve: resolveVisit,
          reject: rejectVisit,
          abort() {
            if (abortedVisitResolvesUndefined(next.method, options)) {
              resolveVisit(undefined);
            } else {
              rejectVisit(abortError());
            }
          },
        },
        settleCapture,
      );
      dispatch({ type: 'begin', resource: next, navigation });

      if (NavigationFallback) {
        let shellSettled = false;
        let revealed = false;
        const reveal = (settled: boolean) => {
          if (revealed || !activeVisit.isActive(next.id)) {
            return;
          }
          revealed = true;
          if (settled) {
            startTransition(() => dispatch({ type: 'reveal', resource: next }));
          } else {
            dispatch({ type: 'reveal', resource: next });
          }
        };
        shell.then((result) => {
          shellSettled = true;
          if (!result) {
            return;
          }
          if (!gated) {
            reveal(true);
            return;
          }
          if (!activeVisit.isActive(next.id)) {
            return;
          }
          // The browser captures the old page, or the fallback when it is already committed,
          // before this callback runs. A visit superseded in between has been released.
          const update = () => {
            activeVisit.settleViewTransitionGate(next.id, true);
            reveal(true);
          };
          try {
            startViewTransition(next, update);
          } catch {
            update();
            activeVisit.releaseViewTransition(next.id);
          }
        });
        // A cached shell settles before the next paint. Avoid committing the fallback
        // for that visit, while still revealing it promptly for a network-bound shell.
        requestAnimationFrame(() => {
          if (!shellSettled) {
            reveal(false);
          }
        });
        return pagePromise;
      }

      const reveal = () => {
        startTransition(() => {
          dispatch({ type: 'reveal', resource: next });
        });
      };

      shell.then(
        (result) => {
          if (result && activeVisit.isActive(next.id)) {
            startViewTransition(next, reveal);
          }
        },
        () => {},
      );
      return pagePromise;
    },
    [NavigationFallback, navigationStore, startTransition],
  );

  useInsertionEffect(() => {
    scheduleVisit = schedule;
    engine.setBrowserVisitHandler(schedule);
    engine.setLocationHandler(() => dispatch({ type: 'location', location: currentUrl() }));
    return () => {
      engine.setBrowserVisitHandler(null);
      engine.setLocationHandler(null);
      if (scheduleVisit === schedule) {
        scheduleVisit = null;
      }
    };
  }, [engine, schedule]);

  const navigationValue = useMemo<NavigationState>(() => {
    if (state.navigation.state !== 'idle' || !isTransitionPending) {
      return state.navigation;
    }
    // Action transitions can delay the reducer's begin and finish updates. Keep
    // the latest destination available synchronously throughout those renders.
    return {
      ...lastNavigation,
      state: 'loading',
    };
  }, [isTransitionPending, lastNavigation, state.navigation]);

  const routeResource = React.createElement(RouteResource, {
    resource: state.resource,
    onCommit: finishNavigation,
    config,
    onFailure: (url: string) => engine.flush(url),
  });

  const routerValue = useMemo(
    () =>
      createRouterFacade(router, () =>
        hydrated ? state.routeUrl : (prerenderedUrl ?? state.routeUrl),
      ),
    [router, state.routeUrl, hydrated],
  );

  return React.createElement(
    RouterContext.Provider,
    { value: routerValue },
    React.createElement(
      NavigationContext.Provider,
      { value: navigationValue },
      React.createElement(
        Suspense,
        {
          fallback:
            NavigationFallback && state.pendingId !== null
              ? React.createElement(NavigationFallback, { initialPageData })
              : null,
        },
        // Page boundaries own render failures when the app declares any; what
        // escapes them reaches the root's terminal error handler.
        hasPageBoundaries(config.boundaryManifest)
          ? routeResource
          : React.createElement(
              RouteRenderBoundary,
              {
                resourceId: state.resource.id,
                pending: state.pendingId === state.resource.id,
                onError(error) {
                  const resource = state.resource;
                  if (!activeVisit.end(resource.id)) {
                    return;
                  }
                  activeVisit.releaseViewTransition(resource.id);
                  const settler = activeVisit.takeSettler(resource.id);
                  if (settler) {
                    settler.reject(error);
                  } else {
                    reportError(error);
                  }
                  dispatch({ type: 'fail', resource, location: currentUrl() });
                },
              },
              routeResource,
            ),
      ),
    ),
  );
}

export async function startReactPages(config: ReactPagesConfig): Promise<ReactPagesClient> {
  activeVisit.reset();
  committedResources = new WeakSet();
  prerenderedUrl = null;

  const engine = await createPageNavigationEngine({
    adapter: {
      createDeferred: createDeferredResource,
      resolveDeferred: resolveDeferredResource,
      rejectDeferred: rejectDeferredResource,
      isLoading: isDeferredResourceLoading,
    },
    components: config.components,
    layoutTree: config.layoutTree,
    routeMeta: config.routeMeta,
    matchRoute: config.matchRoute,
    staticPageData: config.staticPageData,
    staticPageDataFastPath: config.staticPageDataFastPath,
    viewTransitions: config.viewTransitions,
    prefetchHoverDelay: config.prefetchHoverDelay,
    prefetchDefaultCacheFor: config.prefetchDefaultCacheFor,
    prefetchDefaultStrategy: config.prefetchDefaultStrategy,
    cacheVisitedPageData: config.cacheVisitedPageData,
    boundaryManifest: config.boundaryManifest,
    dev: config.dev,
  }).catch((error) => {
    if (hasPageBoundaries(config.boundaryManifest)) {
      showTerminalPageError();
    }
    throw error;
  });
  const router = createRouter(engine);
  setActionRouter(router);

  const appEl = document.getElementById('app');
  if (!appEl) {
    throw new Error('pages: Missing #app element for Void React pages hydration.');
  }

  const isSsr = appEl.getAttribute('data-void-ssr') !== 'false';
  if (isSsr) {
    prerenderedUrl = prerenderedRouteUrl(engine.initialPageData as ReactPageData);
  }
  const appRoot = React.createElement(App, {
    config,
    engine,
    router,
    navigationFallback: config.navigationFallback,
  });
  const hasDeferred = Boolean((engine.initialPageData as ReactPageData).deferredKeys);
  const app =
    isSsr && hasDeferred
      ? React.createElement(
          React.Fragment,
          null,
          appRoot,
          React.createElement('template', { id: DEFERRED_SHELL_END_ID }),
        )
      : appRoot;
  startTransition(() => {
    const rootOptions = hasPageBoundaries(config.boundaryManifest)
      ? {
          onUncaughtError: (error: unknown) => {
            const resource = activeVisit.resource;
            if (resource) {
              resource.dispose();
              engine.flush(resource.fetchUrl);
              engine.flush(resource.destination());
              activeVisit.takeSettler(resource.id)?.reject(error);
              activeVisit.releaseViewTransition(resource.id);
              activeVisit.end(resource.id);
            }
            showTerminalPageError(resource ? resource.destination() : currentUrl());
          },
        }
      : undefined;
    if (!isSsr) {
      createRoot(appEl, rootOptions).render(app);
    } else {
      hydrateRoot(appEl, app, rootOptions);
    }
  });
  engine.start();

  return { router: createRouterFacade(router, currentUrl) };
}
