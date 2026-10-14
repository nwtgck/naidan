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
};

const entries = new WeakMap<DocsIslandEntry, EntryData>();
const definitions = new WeakMap<object, { spec: DocsIslandSpec<JsonObject>; component: Component }>();

export function readDocsIslandEntry({ entry }: { entry: DocsIslandEntry }): EntryData {
  const data = entries.get(entry);
  if (!data) throw new Error('Invalid Docs island entry');
  return data;
}

// The one factory argument is the component's payload itself.
// eslint-disable-next-line local-rules-named-args/require-named-args
export type DocsIslandFactory<Payload extends JsonObject> = <Actual extends Payload>(input: Actual & ExactArgument<Actual, Payload>) => DocsIslandEntry;

export function defineDocsIsland<Payload extends JsonObject, C extends ConcreteComponent>({ spec, component }: {
  spec: DocsIslandSpec<Payload>;
  component: C & (SameProps<Payload, DataProps<C>> extends true ? unknown : never);
}): DocsIslandFactory<Payload> {
  // eslint-disable-next-line local-rules-named-args/require-named-args
  const factory: DocsIslandFactory<Payload> = (input): DocsIslandEntry => {
    const serialized = JSON.stringify(input);
    if (typeof serialized !== 'string') throw new Error(`Docs island ${spec.id} props must serialize to JSON`);
    const canonical = spec.parse({ serialized });
    const entry = { [entryBrand]: true } as const;
    entries.set(entry, { id: spec.id, serialized, canonical, component });
    return entry;
  };
  definitions.set(factory, { spec, component });
  return factory;
}

export function hydrateDocsIsland<Payload extends JsonObject>({ factory, document }: {
  factory: DocsIslandFactory<Payload>;
  document: Document;
}): App<Element>[] {
  const definition = definitions.get(factory);
  if (!definition) throw new Error('Invalid Docs island factory');
  const { spec, component } = definition;
  const apps: App<Element>[] = [];
  for (const root of document.querySelectorAll<HTMLElement>('[data-docs-island]')) {
    if (root.dataset.docsIsland !== spec.id || root.dataset.docsHydrated === 'ready') continue;
    const staticHtml = root.innerHTML;
    let app: App<Element> | undefined;
    try {
      const serialized = root.getAttribute('data-docs-props');
      if (!serialized) throw new Error(`Missing Docs island ${spec.id} props`);
      const canonical = spec.parse({ serialized });
      app = createSSRApp(component, canonical);
      let hydrationError: unknown;
      let hydrationFailed = false;
      app.config.errorHandler = error => {
        hydrationFailed = true;
        hydrationError = error;
      };
      app.mount(root);
      if (hydrationFailed) throw hydrationError;
      app.config.errorHandler = error => console.error(`[Docs ${spec.id}]`, error);
      root.dataset.docsHydrated = 'ready';
      apps.push(app);
    } catch (error) {
      try {
        app?.unmount();
      } catch (cleanupError) {
        console.error(`[Docs ${spec.id}] Could not stop failed island.`, cleanupError);
      }
      root.innerHTML = staticHtml;
      delete root.dataset.docsHydrated;
      console.error(`[Docs ${spec.id}] Could not start island.`, error);
    }
  }
  return apps;
}

export function startDocsIslandHydration<Payload extends JsonObject>({ factory, document }: {
  factory: DocsIslandFactory<Payload>;
  document: Document;
}): void {
  const definition = definitions.get(factory);
  if (!definition) throw new Error('Invalid Docs island factory');
  const start = (): void => {
    hydrateDocsIsland({ factory, document });
  };
  switch (document.readyState) {
  case 'loading':
    document.addEventListener('DOMContentLoaded', start, { once: true });
    return;
  case 'interactive':
    switch (definition.spec.start) {
    case 'dom-content-loaded':
      document.addEventListener('DOMContentLoaded', start, { once: true });
      return;
    case 'interactive':
      start();
      return;
    default: {
      const unreachable: never = definition.spec.start;
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
