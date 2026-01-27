let hasRequestedInSession = false;

export function useStoragePersistence() {
  const requestPersistence = async () => {
    if (hasRequestedInSession) return;
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persist) {
      return;
    }

    try {
      const alreadyPersisted = await navigator.storage.persisted();
      if (alreadyPersisted) {
        hasRequestedInSession = true;
        return;
      }

      const persistent = await navigator.storage.persist();
      hasRequestedInSession = true;
      if (persistent) {
        console.log("Storage is now persistent. It will not be cleared except by explicit user action.");
      } else {
        console.log("Storage is not persistent. It may be cleared by the UA under storage pressure.");
      }
    } catch (e) {
      console.error('Failed to request storage persistence:', e);
    }
  };

  return {
    requestPersistence,
  };
}