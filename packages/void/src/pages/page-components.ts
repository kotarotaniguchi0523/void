import { clientPageError, pageBoundarySlots } from './boundary-client.ts';
import type {
  PageData,
  PageNavigationEngineConfig,
  PageNavigationResult,
} from './navigation-engine.ts';

/** Loads page and layout components, and the boundary that replaces a page that fails to load. */
export function createPageComponentLoader(
  config: Pick<
    PageNavigationEngineConfig,
    'components' | 'layoutTree' | 'boundaryManifest' | 'dev'
  >,
): {
  resolveComponent(id: string): Promise<unknown>;
  resolveLayouts(componentId: string): Promise<Array<unknown>>;
  /** A boundary page for an import failure of `page`; rethrows `error` when none loads. */
  recoverImportFailure(page: PageData, error: unknown): Promise<PageNavigationResult>;
} {
  const { components, layoutTree } = config;

  async function resolveComponent(id: string): Promise<unknown> {
    const loader = components[id];
    if (!loader) {
      throw new Error(`pages: Unknown page component '${id}'.`);
    }
    return (await loader()).default;
  }

  async function resolveLayouts(componentId: string): Promise<Array<unknown>> {
    const ids = layoutTree[componentId] || [];
    return Promise.all(ids.map(async (id: string) => (await components[id]()).default));
  }

  async function recoverImportFailure(
    page: PageData,
    error: unknown,
  ): Promise<PageNavigationResult> {
    for (const boundary of pageBoundarySlots(config.boundaryManifest, page.component, components)) {
      const pageData: PageData = {
        ...page,
        component: boundary.id,
        props: { error: clientPageError(error, config.dev) },
        deferred: undefined,
        deferredKeys: undefined,
        deferredErrors: undefined,
        errors: null,
      };
      try {
        const [component, layouts] = await Promise.all([
          resolveComponent(boundary.id),
          resolveLayouts(boundary.id),
        ]);
        return { pageData, component, layouts };
      } catch {
        /* A failed fallback import or layout tries its parent. */
      }
    }
    throw error;
  }

  return { resolveComponent, resolveLayouts, recoverImportFailure };
}
