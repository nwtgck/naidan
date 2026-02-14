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
    const root = await navigator.storage.getDirectory();

    // Safari check: navigator.storage.getDirectory() exists but FileSystemFileHandle.createWritable might be missing.
    // We attempt to create a temporary file to check for full OPFS support.
    const testFileName = `naidan-feature-detection-check-${Math.random().toString(36).slice(2)}.txt`;
    try {
      const fileHandle = await root.getFileHandle(testFileName, { create: true });
      const hasCreateWritable = 'createWritable' in fileHandle && typeof (fileHandle as unknown as Record<string, unknown>).createWritable === 'function';

      // Clean up the test file
      await root.removeEntry(testFileName).catch(() => {});

      if (!hasCreateWritable) {
        console.warn('OPFS detection: getDirectory() succeeded but createWritable is missing (likely Safari without full OPFS support).');
        return false;
      }
    } catch (e) {
      console.warn('OPFS detection: Failed to create test file in root directory.', e);
      return false;
    }

    return true;
  } catch (e) {
    // If it throws, OPFS is not actually available or accessible in this context
    console.warn('OPFS detection: navigator.storage.getDirectory() failed.', e);
    return false;
  }
}
