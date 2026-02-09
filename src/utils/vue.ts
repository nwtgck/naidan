import { defineAsyncComponent, onMounted, type Component, type ComponentPublicInstance } from 'vue';

type AsyncComponentResolveResult<T = Component> = T | {
    default: T;
};
export type AsyncComponentLoader<T = Component> = () => Promise<AsyncComponentResolveResult<T>>;

/**
 * Defines an async component and automatically starts fetching its resources
 * when the parent component is mounted and the browser is idle.
 * 
 * Note: Must be called within <script setup> or setup() as it uses onMounted.
 */
export function defineAsyncComponentAndLoadOnMounted<T extends Component = {
    new (): ComponentPublicInstance;
}>(loader: AsyncComponentLoader<T>) {
  const Comp = defineAsyncComponent(loader);

  onMounted(() => {
    const runLoader = () => {
      loader().catch(() => {
        // Prefetch failures can be ignored; defineAsyncComponent will handle them on actual render.
      });
    };

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback(runLoader);
    } else {
      // Fallback: slight delay to avoid interfering with initial render
      setTimeout(runLoader, 200);
    }
  });

  return Comp;
}
