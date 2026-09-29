/** A real document reload is required, including at an unchanged #/chat/... URL.
 * location.replace(currentHref) can be a same-document navigation instead.
 * Remove ONLY the obsolete 004-006 marker; preserve routing and user parameters.
 */
export function reloadPWAPage({ location, history }: {
  location: Pick<Location, 'href' | 'reload'>;
  history: Pick<History, 'state' | 'replaceState'>;
}): void {
  try {
    const url = new URL(location.href);
    if (url.searchParams.has('__naidan_update')) {
      url.searchParams.delete('__naidan_update');
      history.replaceState(history.state, '', url.href);
    }
  } catch (error) {
    // Legacy cleanup is cosmetic. A history API restriction must not prevent
    // the actual update after activation/network mode already succeeded.
    console.warn('[PWA] Could not remove the obsolete update marker.', error);
  }
  location.reload();
}

export const TEST_ONLY = {
};
