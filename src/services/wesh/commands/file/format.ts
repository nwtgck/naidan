import type { FileCommandClassification } from './types';

export function formatFileClassification({
  classification,
}: {
  classification: FileCommandClassification;
}): string {
  switch (classification.kind) {
  case 'directory':
    return 'directory';
  case 'fifo':
    return 'fifo (named pipe)';
  case 'symlink':
    return `symbolic link to ${classification.target}`;
  case 'empty':
    return 'empty';
  case 'binary':
    return `${classification.detected.mime} (${classification.detected.ext})`;
  case 'json':
    return 'JSON text data';
  case 'xml':
    return 'XML document text';
  case 'svg':
    return 'SVG Scalable Vector Graphics image';
  case 'html':
    return 'HTML document text';
  case 'shell-script':
    return 'POSIX shell script text executable';
  case 'ascii-text':
    return 'ASCII text';
  case 'utf8-text':
    return 'Unicode text, UTF-8 text';
  case 'utf16-text':
    return 'Unicode text, UTF-16 text';
  case 'data':
    return 'data';
  default: {
    const _ex: never = classification;
    throw new Error(`Unhandled file classification: ${JSON.stringify(_ex)}`);
  }
  }
}

export function formatFileMime({
  classification,
}: {
  classification: FileCommandClassification;
}): string {
  switch (classification.kind) {
  case 'directory':
    return 'inode/directory';
  case 'fifo':
    return 'inode/fifo';
  case 'symlink':
    return 'inode/symlink';
  case 'empty':
    return 'inode/x-empty';
  case 'binary':
    return classification.detected.mime;
  case 'json':
    return 'application/json';
  case 'xml':
    return 'application/xml';
  case 'svg':
    return 'image/svg+xml';
  case 'html':
    return 'text/html';
  case 'shell-script':
    return 'text/x-shellscript';
  case 'ascii-text':
  case 'utf8-text':
  case 'utf16-text':
    return 'text/plain';
  case 'data':
    return 'application/octet-stream';
  default: {
    const _ex: never = classification;
    throw new Error(`Unhandled file classification for mime: ${JSON.stringify(_ex)}`);
  }
  }
}
