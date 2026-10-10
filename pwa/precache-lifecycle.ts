/** Wait BEFORE writing the shared precache if an activation is deleting entries.
 * Conversely, activation must skip cleanup if an installer already owns the slot.
 * These two sides protect future installers without duplicating large caches.
 */
export function waitForActiveCleanup({ registration }: { registration: ServiceWorkerRegistration }): Promise<void> {
  const active = registration.active;
  if (!active || active.state !== 'activating') return Promise.resolve();
  return new Promise(resolve => {
    const check = () => {
      switch (active.state) {
      case 'activating': return;
      case 'activated':
      case 'redundant':
      case 'installed':
      case 'installing':
      case 'parsed': break;
      default: { const exhaustive: never = active.state; throw new Error(`Unexpected worker state: ${exhaustive}`); }
      }
      active.removeEventListener('statechange', check);
      resolve();
    };
    active.addEventListener('statechange', check);
    check();
  });
}

export const TEST_ONLY = {
};
