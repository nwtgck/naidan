import { computed, hasInjectionContext, inject, onActivated, onDeactivated, onScopeDispose, provide, ref, shallowReactive, watchEffect, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import { START_LOCATION, type Router } from 'vue-router';
import { HOME_METADATA, applyDocumentMetadata, isHomeIntroductionActive, routeDocumentMetadata, type HomeIntroduction, type PageMetadata } from '@/logic/document-metadata';
import { resolveInitialRoute } from '@/logic/startup/startup-route';
import { lazyStrings } from '@/strings';
import { exactObject } from '@/utils/exact-object';

type ScopedPageMetadata = Readonly<{ routePath: string, metadata: PageMetadata }>;
type ScopedTitle = Readonly<{ routePath: string, title: string }>;

function createDocumentMetadata({ router, document, homeIntroduction, finishHomeIntroduction }: {
  router: Router | undefined,
  document: Document,
  homeIntroduction: Readonly<Ref<HomeIntroduction>>,
  finishHomeIntroduction: () => void,
}) {
  const pages = shallowReactive(new Map<symbol, ComputedRef<ScopedPageMetadata | undefined>>());
  const loadingTitles = shallowReactive(new Map<symbol, ComputedRef<ScopedTitle | undefined>>());
  const printTitles = shallowReactive(new Map<symbol, string>());
  let disposed = false;
  onScopeDispose(() => {
    disposed = true;
  });
  const route = computed(() => router === undefined ? undefined
    : router.currentRoute.value === START_LOCATION ? resolveInitialRoute({ router }) : router.currentRoute.value);
  function matchesCurrentRoute({ routePath }: { routePath: string }): boolean {
    return route.value !== undefined && routePath.replace(/\/+$/, '') === route.value.path.replace(/\/+$/, '');
  }
  const introduction = computed(() => isHomeIntroductionActive({ introduction: homeIntroduction.value, route: route.value }));
  const page = computed(() => {
    if (introduction.value) {
      const title = lazyStrings.documentTitle__run_ai_on_your_device_directly_in_your_browser();
      // Keep the initial HTML's English metadata until this boundary is ready.
      if (title === undefined) {
        return HOME_METADATA;
      }
      return exactObject<PageMetadata>()({ title, description: HOME_METADATA.description });
    }
    for (const source of [...pages.values()].reverse()) {
      const value = source.value;
      if (value !== undefined && matchesCurrentRoute({ routePath: value.routePath })) {
        return value.metadata;
      }
    }
    return routeDocumentMetadata({ route: route.value });
  });

  function apply(): void {
    if (disposed) {
      return;
    }
    let documentTitle = [...printTitles.values()].at(-1);
    if (documentTitle === undefined && !introduction.value) {
      for (const source of [...loadingTitles.values()].reverse()) {
        const value = source.value;
        if (value !== undefined && matchesCurrentRoute({ routePath: value.routePath })) {
          documentTitle = value.title;
          break;
        }
      }
    }
    applyDocumentMetadata({ document, page: page.value, documentTitle: documentTitle ?? page.value.title });
  }

  watchEffect(apply, { flush: 'post' });
  apply();

  function registerPage({ source }: { source: ComputedRef<ScopedPageMetadata | undefined> }): () => void {
    const token = Symbol('page');
    pages.set(token, source);
    return () => {
      pages.delete(token);
    };
  }

  function registerLoadingTitle({ source }: { source: ComputedRef<ScopedTitle | undefined> }): () => void {
    const token = Symbol('model-loading');
    loadingTitles.set(token, source);
    return () => {
      loadingTitles.delete(token);
    };
  }

  async function withPrintTitle({ title, run }: { title: string | undefined, run: () => Promise<void> }): Promise<void> {
    const token = Symbol('printing');
    try {
      if (title !== undefined) {
        printTitles.set(token, title);
      }
      // Printing needs the new title synchronously, before its callback can run.
      apply();
      await run();
    } finally {
      printTitles.delete(token);
      apply();
    }
  }

  return { registerPage, registerLoadingTitle, withPrintTitle, finishHomeIntroduction };
}

type DocumentMetadata = ReturnType<typeof createDocumentMetadata>;
const metadataKey: InjectionKey<DocumentMetadata> = Symbol('document-metadata');

export function provideDocumentMetadata({ router, document, homeIntroduction, finishHomeIntroduction }: {
  router: Router | undefined,
  document: Document,
  homeIntroduction: Readonly<Ref<HomeIntroduction>>,
  finishHomeIntroduction: () => void,
}): void {
  provide(metadataKey, createDocumentMetadata({ router, document, homeIntroduction, finishHomeIntroduction }));
}

export function useDocumentMetadata(): DocumentMetadata | undefined {
  // Isolated/embedded components do not own the host document's metadata.
  return hasInjectionContext() ? inject(metadataKey, undefined) : undefined;
}

function useActiveSource<T>({ source }: { source: ComputedRef<T | undefined> }): ComputedRef<T | undefined> {
  const activity = ref<'active' | 'inactive'>('active');
  onActivated(() => {
    activity.value = 'active';
  });
  onDeactivated(() => {
    activity.value = 'inactive';
  });
  return computed(() => {
    const current = activity.value;
    switch (current) {
    case 'active': return source.value;
    case 'inactive': return undefined;
    default: {
      const _ex: never = current;
      return _ex;
    }
    }
  });
}

export function usePageDocumentMetadata({ source }: { source: ComputedRef<ScopedPageMetadata | undefined> }): void {
  const metadata = useDocumentMetadata();
  if (metadata === undefined) {
    return;
  }
  const release = metadata.registerPage({ source: useActiveSource({ source }) });
  onScopeDispose(release);
}

export function useDocumentTitleOverride({ kind, source }: {
  kind: 'model-loading',
  source: ComputedRef<ScopedTitle | undefined>,
}): void {
  const metadata = useDocumentMetadata();
  if (metadata === undefined) {
    return;
  }
  switch (kind) {
  case 'model-loading': {
    const release = metadata.registerLoadingTitle({ source: useActiveSource({ source }) });
    onScopeDispose(release);
    return;
  }
  default: {
    const _ex: never = kind;
    return _ex;
  }
  }
}

export const TEST_ONLY = {
};
