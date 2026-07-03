export function createTailwindCssRegistry({ document, scheduleFlush }) {
  const modules = new Map();
  let scheduled = false;
  let styleElement;

  function ensureStyleElement() {
    if (styleElement?.isConnected === true) return styleElement;
    const existing = document.head.querySelector('style[data-naidan-tailwind-runtime]');
    if (existing !== null) {
      styleElement = existing;
      return styleElement;
    }
    const created = document.createElement('style');
    created.setAttribute('data-naidan-tailwind-runtime', '');
    document.head.prepend(created);
    styleElement = created;
    return styleElement;
  }

  function flush() {
    scheduled = false;
    const fragments = [...modules.entries()]
      .flatMap(([moduleId, values]) => values.map(([order, css]) => ({ moduleId, order, css })))
      .sort((left, right) => left.order - right.order || left.moduleId.localeCompare(right.moduleId));
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
      modules.set(moduleId, fragments.map(([order, css]) => [order, css]));
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
