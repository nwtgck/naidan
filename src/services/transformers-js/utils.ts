/**
 * Interface to extend FileSystemFileHandle with the non-standard createWritable method.
 */
export interface FileSystemFileHandleWithWritable extends FileSystemFileHandle {
  createWritable(): Promise<FileSystemWritableFileStream>;
}

/**
 * Converts a URL (Hugging Face or local) to an OPFS path.
 */
export function urlToPath({ url }: { url: string }): string | null {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(p => !!p);

    const isLocalOrigin = parsed.origin === self.location.origin ||
                          parsed.hostname === 'localhost' ||
                          parsed.hostname === '127.0.0.1';

    if (isLocalOrigin) {
      const first = pathParts[0];
      if (first === 'user' || first === 'local' || first === 'models') {
        let startIndex = 0;
        switch (first) {
        case 'models':
          startIndex++;
          break;
        case 'user':
        case 'local':
          break;
        default: {
          const _ex: never = first;
          throw new Error(`Unhandled path part: ${_ex}`);
        }
        }
        if (pathParts[startIndex] === 'user' || pathParts[startIndex] === 'local') startIndex++;

        const cleanParts = pathParts.slice(startIndex);
        const resolved = `models/user/${cleanParts.join('/')}`;
        return resolved;
      }
      return null;
    }

    const resolved = `models/${parsed.hostname}/${pathParts.join('/')}`;
    return resolved;
  } catch {
    const parts = url.split('/').filter(p => !!p);
    const first = parts[0];
    if (first === 'user' || first === 'local' || first === 'models') {
      let startIndex = 0;
      switch (first) {
      case 'models':
        startIndex++;
        break;
      case 'user':
      case 'local':
        break;
      default: {
        const _ex: never = first;
        throw new Error(`Unhandled path part: ${_ex}`);
      }
      }
      if (parts[startIndex] === 'user' || parts[startIndex] === 'local') startIndex++;
      const resolved = `models/user/${parts.slice(startIndex).join('/')}`;
      return resolved;
    }
    return null;
  }
}

/**
 * Writes a response body (stream) to OPFS at the resolved path.
 */
export async function writeToOpfs({ path, response }: { path: string, response: Response }): Promise<void> {
  const pathParts = path.split('/');
  const fileName = pathParts.pop()!;

  const root = await navigator.storage.getDirectory();
  let currentDir = root;
  for (const part of pathParts) {
    if (!part) continue;
    currentDir = await currentDir.getDirectoryHandle(part, { create: true });
  }

  const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
  if ('createWritable' in fileHandle) {
    const writable = await (fileHandle as unknown as FileSystemFileHandleWithWritable).createWritable();
    if (response.body) {
      await response.body.pipeTo(writable);
    } else {
      const buffer = await response.arrayBuffer();
      await writable.write(buffer);
      await writable.close();
    }

    // Create completion marker after successful write/close
    await currentDir.getFileHandle(`.${fileName}.complete`, { create: true });
  }
}
