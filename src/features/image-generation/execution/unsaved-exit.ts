/** Keep the browser-close warning alive after the last image component leaves.
 * This prevents accidental closure; it is not durable storage or a guarantee
 * that the browser will display a dialog. No unload handler attempts to save. */
export function protectUnsavedImages({ target, subscribe, hasPending }: {
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  subscribe({ listener }: { listener(): void }): () => void,
  hasPending(): boolean,
}) {
  let installed = false;
  const warn: EventListener = event => event.preventDefault();
  const update = () => {
    const pending = hasPending();
    if (pending && !installed) {
      target.addEventListener('beforeunload', warn); installed = true;
    } else if (!pending && installed) {
      target.removeEventListener('beforeunload', warn); installed = false;
    }
  };
  const unsubscribe = subscribe({ listener: update }); update();
  return () => {
    unsubscribe(); target.removeEventListener('beforeunload', warn); installed = false;
  };
}
export const TEST_ONLY = {
};
