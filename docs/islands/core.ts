import { createSSRApp } from 'vue';
import type { AllowedComponentProps, App, Component, ComponentCustomProps, VNodeProps } from 'vue';
import type { DocsIslandSpec, JsonObject } from './spec';

// Vue's component constructor is an external positional signature.
// eslint-disable-next-line local-rules-named-args/require-named-args
type ConcreteComponent = new (...args: never[]) => { $props: object };
type DataProps<C extends ConcreteComponent> = Omit<InstanceType<C>['$props'], keyof VNodeProps | keyof AllowedComponentProps | keyof ComponentCustomProps>;
type Keys<T> = T extends unknown ? keyof T : never;
type SameKeys<A, B> = [Exclude<Keys<A>, Keys<B>>] extends [never]
  ? [Exclude<Keys<B>, Keys<A>>] extends [never] ? true : false
  : false;
type SameProps<A, B> = SameKeys<A, B> extends true
  ? [A] extends [B] ? [B] extends [A] ? true : false : false
  : false;
type ExactArgument<Actual, Expected> = [Exclude<Keys<Actual>, Keys<Expected>>] extends [never] ? unknown : never;

const entryBrand: unique symbol = Symbol('Docs island entry');
export type DocsIslandEntry = { readonly [entryBrand]: true };

type EntryData = {
  id: string;
  serialized: string;
  canonical: JsonObject;
  component: Component;
  prepare: () => Promise<void>;
};

const entries = new WeakMap<DocsIslandEntry, EntryData>();
const definitions = new WeakMap<object, {
  id: string;
  start: DocsIslandSpec<JsonObject>['start'];
  component: Component;
  parseAndPrepare: ({ serialized }: { serialized: string }) => Promise<JsonObject>;
}>();
const pendingRoots = new WeakSet<HTMLElement>();

export function readDocsIslandEntry({ entry }: { entry: DocsIslandEntry }): EntryData {
  const data = entries.get(entry);
  if (!data) throw new Error('Invalid Docs island entry');
  return data;
}

// The one factory argument is the component's payload itself.
// eslint-disable-next-line local-rules-named-args/require-named-args
export type DocsIslandFactory<Payload extends JsonObject> = <Actual extends Payload>(input: Actual & ExactArgument<Actual, Payload>) => DocsIslandEntry;

export function defineDocsIsland<Payload extends JsonObject, C extends ConcreteComponent>({ spec, component, prepare }: {
  spec: DocsIslandSpec<Payload>;
  component: C & (SameProps<Payload, DataProps<C>> extends true ? unknown : never);
  prepare: ({ payload }: { payload: Payload }) => Promise<void>;
}): DocsIslandFactory<Payload> {
  // eslint-disable-next-line local-rules-named-args/require-named-args
  const factory: DocsIslandFactory<Payload> = (input): DocsIslandEntry => {
    const serialized = JSON.stringify(input);
    if (typeof serialized !== 'string') throw new Error(`Docs island ${spec.id} props must serialize to JSON`);
    const canonical = spec.parse({ serialized });
    const entry = { [entryBrand]: true } as const;
    entries.set(entry, { id: spec.id, serialized, canonical, component, prepare: () => prepare({ payload: canonical }) });
    return entry;
  };
  definitions.set(factory, {
    id: spec.id,
    start: spec.start,
    component,
    parseAndPrepare: async ({ serialized }) => {
      const canonical = spec.parse({ serialized });
      await prepare({ payload: canonical });
      return canonical;
    },
  });
  return factory;
}

export async function hydrateDocsIsland<Payload extends JsonObject>({ factory, document }: {
  factory: DocsIslandFactory<Payload>;
  document: Document;
}): Promise<App<Element>[]> {
  const definition = definitions.get(factory);
  if (!definition) throw new Error('Invalid Docs island factory');
  const roots = [...document.querySelectorAll<HTMLElement>('[data-docs-island]')];
  const results = await Promise.all(roots.map(async root => {
    if (root.dataset.docsIsland !== definition.id || root.dataset.docsHydrated === 'ready' || pendingRoots.has(root)) return undefined;
    pendingRoots.add(root);
    let app: App<Element> | undefined;
    let staticHtml: string | undefined;
    let mountStarted = false;
    try {
      const serialized = root.getAttribute('data-docs-props');
      if (!serialized) throw new Error(`Missing Docs island ${definition.id} props`);
      const canonical = await definition.parseAndPrepare({ serialized });
      if (!root.isConnected || root.ownerDocument !== document || root.dataset.docsIsland !== definition.id
        || root.dataset.docsHydrated === 'ready' || root.getAttribute('data-docs-props') !== serialized) return undefined;
      staticHtml = root.innerHTML;
      app = createSSRApp(definition.component, canonical);
      let hydrationError: unknown;
      let hydrationFailed = false;
      app.config.errorHandler = error => {
        hydrationFailed = true;
        hydrationError = error;
      };
      mountStarted = true;
      app.mount(root);
      if (hydrationFailed) throw hydrationError;
      app.config.errorHandler = error => console.error(`[Docs ${definition.id}]`, error);
      root.dataset.docsHydrated = 'ready';
      return app;
    } catch (error) {
      if (mountStarted) {
        try {
          app?.unmount();
        } catch (cleanupError) {
          console.error(`[Docs ${definition.id}] Could not stop failed island.`, cleanupError);
        }
        if (staticHtml !== undefined) root.innerHTML = staticHtml;
        delete root.dataset.docsHydrated;
      }
      console.error(`[Docs ${definition.id}] Could not start island.`, error);
      return undefined;
    } finally {
      pendingRoots.delete(root);
    }
  }));
  return results.flatMap(app => app ? [app] : []);
}

export function startDocsIslandHydration<Payload extends JsonObject>({ factory, document }: {
  factory: DocsIslandFactory<Payload>;
  document: Document;
}): void {
  const definition = definitions.get(factory);
  if (!definition) throw new Error('Invalid Docs island factory');
  const start = (): void => {
    void hydrateDocsIsland({ factory, document }).catch(error => {
      console.error(`[Docs ${definition.id}] Could not start hydration.`, error);
    });
  };
  switch (document.readyState) {
  case 'loading':
    document.addEventListener('DOMContentLoaded', start, { once: true });
    return;
  case 'interactive':
    switch (definition.start) {
    case 'dom-content-loaded':
      document.addEventListener('DOMContentLoaded', start, { once: true });
      return;
    case 'interactive':
      start();
      return;
    default: {
      const unreachable: never = definition.start;
      throw new Error(`Unsupported island start time: ${unreachable}`);
    }
    }
  case 'complete':
    start();
    return;
  default: {
    const unreachable: never = document.readyState;
    throw new Error(`Unsupported document state: ${unreachable}`);
  }
  }
}
