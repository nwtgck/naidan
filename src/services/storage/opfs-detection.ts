/**
 * Checks if Origin Private File System (OPFS) is supported and accessible.
 * 
 * Simply checking for the existence of `navigator.storage.getDirectory` is not enough,
 * as it may exist in insecure contexts or certain environments (like Chrome with file:// protocol)
 * but throw an error when actually called.
 */
export async function checkOPFSSupport(): Promise<boolean> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.getDirectory !== 'function'
  ) {
    return false;
  }

  try {
    // Some environments (like Chrome on file://) have the function but it throws when called
    await navigator.storage.getDirectory();
    return true;
  } catch (e) {
    // If it throws, OPFS is not actually available or accessible in this context
    console.warn('OPFS detection: navigator.storage.getDirectory() failed.', e);
    return false;
  }
}
