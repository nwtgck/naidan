export function createTailwindCssRegistry({ document, scheduleFlush }) {
  const modules = new Map();
  let registrationVersion = 0;
  let scheduled = false;
  let styleElement;

  function placeStyleFirst({ style }) {
    if (document.head.firstElementChild !== style) document.head.prepend(style);
    return style;
  }

  function ensureStyleElement() {
    const existingStyles = [...document.head.querySelectorAll('style[data-naidan-tailwind-runtime]')];
    const selected = styleElement?.isConnected === true
      ? styleElement
      : existingStyles[0];
    for (const existing of existingStyles) {
      if (existing !== selected) existing.remove();
    }
    if (selected !== undefined) {
      styleElement = selected;
      return placeStyleFirst({ style: styleElement });
    }
    const created = document.createElement('style');
    created.setAttribute('data-naidan-tailwind-runtime', '');
    styleElement = created;
    return placeStyleFirst({ style: styleElement });
  }

  function flush() {
    scheduled = false;
    const fragmentByOrder = new Map();
    for (const [moduleId, { fragments, version }] of modules) {
      for (const [order, css] of fragments) {
        const current = fragmentByOrder.get(order);
        if (
          current === undefined
          || current.version < version
          || (current.version === version && current.moduleId < moduleId)
        ) fragmentByOrder.set(order, { moduleId, order, css, version });
      }
    }
    const fragments = [...fragmentByOrder.values()]
      .sort((left, right) => left.order - right.order || (left.moduleId < right.moduleId ? -1 : left.moduleId > right.moduleId ? 1 : 0));
    const css = fragments.map(({ css: fragmentCss }) => fragmentCss).join('\n');
    const style = ensureStyleElement();
    if (style.textContent !== css) style.textContent = css;
  }

  function requestFlush() {
    if (scheduled) return;
    scheduled = true;
    scheduleFlush({ callback: flush });
  }

  return {
    register({ moduleId, fragments }) {
      const normalized = fragments.map(([order, css]) => [order, css]);
      const orders = new Set();
      for (const [order, css] of normalized) {
        if (!Number.isInteger(order) || order < 0 || typeof css !== 'string') {
          throw new TypeError(`Invalid static Tailwind CSS fragment in ${moduleId}.`);
        }
        if (orders.has(order)) {
          throw new Error(`Duplicate static Tailwind CSS fragment order ${order} in ${moduleId}.`);
        }
        orders.add(order);
      }
      const current = modules.get(moduleId);
      if (
        current !== undefined
        && current.fragments.length === normalized.length
        && current.fragments.every(([order, css], index) => (
          normalized[index]?.[0] === order && normalized[index]?.[1] === css
        ))
      ) {
        const changesVisibleOrder = [...modules.entries()].some(([otherModuleId, other]) => (
          otherModuleId !== moduleId
          && current.version < other.version
          && other.fragments.some(([order]) => orders.has(order))
        ));
        registrationVersion += 1;
        modules.set(moduleId, { fragments: normalized, version: registrationVersion });
        if (changesVisibleOrder) requestFlush();
        return;
      }
      registrationVersion += 1;
      modules.set(moduleId, { fragments: normalized, version: registrationVersion });
      requestFlush();
    },
    unregister({ moduleId }) {
      if (!modules.delete(moduleId)) return;
      requestFlush();
    },
    flush,
  };
}

export function createTailwindCssRuntimeModuleSource() {
  return `const createTailwindCssRegistry = ${createTailwindCssRegistry.toString()};
const globalKey = '__NAIDAN_STATIC_TAILWIND_CSS_RUNTIME_V1__';
function createRegistry() {
  if (typeof document === 'undefined') {
    return { register() {}, unregister() {}, flush() {} };
  }
  return createTailwindCssRegistry({
    document,
    scheduleFlush: ({ callback }) => {
      if (typeof queueMicrotask === 'function') queueMicrotask(callback);
      else Promise.resolve().then(callback);
    },
  });
}
const registry = globalThis[globalKey] ??= createRegistry();
export function registerTailwindCssModule({ moduleId, fragments }) {
  registry.register({ moduleId, fragments });
}
export function unregisterTailwindCssModule({ moduleId }) {
  registry.unregister({ moduleId });
}
export function unregisterTailwindCssModules({ moduleIds }) {
  for (const moduleId of moduleIds) registry.unregister({ moduleId });
}
`;
}

export function createTailwindCssRegistrationModuleSource({ moduleId, fragments, runtimeModuleId }) {
  return `import { registerTailwindCssModule, unregisterTailwindCssModule } from ${JSON.stringify(runtimeModuleId)};
const moduleId = ${JSON.stringify(moduleId)};
registerTailwindCssModule({ moduleId, fragments: ${JSON.stringify(fragments)} });
if (import.meta.hot) {
  import.meta.hot.accept();
  import.meta.hot.dispose(() => unregisterTailwindCssModule({ moduleId }));
}
`;
}
