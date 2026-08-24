import type {
  FileCommandClassification,
  FileCommandTextDetails,
} from './types';

function formatTextQualifiers({
  text,
}: {
  text: FileCommandTextDetails,
}): string {
  const qualifiers: string[] = [];
  if (text.veryLongLineLength !== undefined) {
    qualifiers.push(`with very long lines (${text.veryLongLineLength})`);
  }
  if (text.lineTerminators.length === 0) {
    qualifiers.push('with no line terminators');
  } else if (!(text.lineTerminators.length === 1 && text.lineTerminators[0] === 'lf')) {
    const names = text.lineTerminators.map((terminator) => {
      switch (terminator) {
      case 'crlf':
        return 'CRLF';
      case 'cr':
        return 'CR';
      case 'lf':
        return 'LF';
      case 'nel':
        return 'NEL';
      default: {
        const _ex: never = terminator;
        throw new Error(`Unhandled line terminator: ${_ex}`);
      }
      }
    });
    qualifiers.push(`with ${names.join(', ')} line terminators`);
  }
  if (text.hasEscapeSequences) qualifiers.push('with escape sequences');
  if (text.hasOverstriking) qualifiers.push('with overstriking');
  return qualifiers.length === 0 ? '' : `, ${qualifiers.join(', ')}`;
}

function formatGenericText({
  text,
}: {
  text: FileCommandTextDetails,
}): string {
  const qualifiers = formatTextQualifiers({ text });
  switch (text.encoding) {
  case 'us-ascii':
    return `ASCII text${qualifiers}`;
  case 'iso-8859-1':
    return `ISO-8859 text${qualifiers}`;
  case 'unknown-8bit':
    return `Non-ISO extended-ASCII text${qualifiers}`;
  case 'utf-8':
    return text.hasByteOrderMark
      ? `Unicode text, UTF-8 (with BOM) text${qualifiers}`
      : `Unicode text, UTF-8 text${qualifiers}`;
  case 'utf-16le':
    return `Unicode text, UTF-16, little-endian text${qualifiers}`;
  case 'utf-16be':
    return `Unicode text, UTF-16, big-endian text${qualifiers}`;
  default: {
    const _ex: never = text.encoding;
    throw new Error(`Unhandled text encoding: ${_ex}`);
  }
  }
}

function formatStructuredTextSuffix({
  text,
}: {
  text: FileCommandTextDetails,
}): string {
  switch (text.encoding) {
  case 'us-ascii':
    return 'ASCII text';
  case 'iso-8859-1':
    return 'ISO-8859 text';
  case 'unknown-8bit':
    return 'Non-ISO extended-ASCII text';
  case 'utf-8':
    return text.hasByteOrderMark ? 'Unicode text, UTF-8 (with BOM) text' : 'Unicode text, UTF-8 text';
  case 'utf-16le':
    return 'Unicode text, UTF-16, little-endian text';
  case 'utf-16be':
    return 'Unicode text, UTF-16, big-endian text';
  default: {
    const _ex: never = text.encoding;
    throw new Error(`Unhandled structured text encoding: ${_ex}`);
  }
  }
}

export function formatFileClassification({
  classification,
}: {
  classification: FileCommandClassification,
}): string {
  switch (classification.kind) {
  case 'directory':
    return 'directory';
  case 'fifo':
    return 'fifo (named pipe)';
  case 'symlink':
    return classification.broken
      ? `broken symbolic link to ${classification.target}`
      : `symbolic link to ${classification.target}`;
  case 'empty':
    return 'empty';
  case 'binary':
    return `${classification.detected.mime} (${classification.detected.ext})`;
  case 'json':
    return 'JSON text data';
  case 'xml':
    return classification.version === undefined
      ? `XML document, ${formatStructuredTextSuffix({ text: classification.text })}`
      : `XML ${classification.version} document, ${formatStructuredTextSuffix({ text: classification.text })}`;
  case 'svg':
    return `SVG Scalable Vector Graphics image, ${formatStructuredTextSuffix({ text: classification.text })}`;
  case 'html':
    return `HTML document, ${formatStructuredTextSuffix({ text: classification.text })}`;
  case 'script': {
    const text = formatStructuredTextSuffix({ text: classification.text });
    switch (classification.language) {
    case 'posix_shell':
      return `POSIX shell script, ${text} executable`;
    case 'bash':
      return `Bourne-Again shell script, ${text} executable`;
    case 'python':
      return `Python script, ${text} executable`;
    case 'node':
      return `Node.js script executable, ${text}`;
    default: {
      const _ex: never = classification.language;
      throw new Error(`Unhandled script language: ${_ex}`);
    }
    }
  }
  case 'ascii_text':
  case 'extended_ascii_text':
  case 'utf8_text':
  case 'utf16_text':
    return formatGenericText({ text: classification.text });
  case 'data':
    return 'data';
  default: {
    const _ex: never = classification;
    throw new Error(`Unhandled file classification: ${JSON.stringify(_ex)}`);
  }
  }
}

export function formatFileMimeType({
  classification,
}: {
  classification: FileCommandClassification,
}): string {
  switch (classification.kind) {
  case 'directory':
    return 'inode/directory';
  case 'fifo':
    return 'inode/fifo';
  case 'symlink':
    return 'inode/symlink';
  case 'empty':
    switch (classification.source) {
    case 'file':
      return 'inode/x-empty';
    case 'stdin':
      return 'application/x-empty';
    default: {
      const _ex: never = classification.source;
      throw new Error(`Unhandled empty source: ${String(_ex)}`);
    }
    }
  case 'binary':
    return classification.detected.mime;
  case 'json':
    return 'application/json';
  case 'xml':
    return 'text/xml';
  case 'svg':
    return 'image/svg+xml';
  case 'html':
    return 'text/html';
  case 'script':
    switch (classification.language) {
    case 'posix_shell':
    case 'bash':
      return 'text/x-shellscript';
    case 'python':
      return 'text/x-script.python';
    case 'node':
      return 'application/javascript';
    default: {
      const _ex: never = classification.language;
      throw new Error(`Unhandled script language MIME type: ${_ex}`);
    }
    }
  case 'ascii_text':
  case 'extended_ascii_text':
  case 'utf8_text':
  case 'utf16_text':
    return 'text/plain';
  case 'data':
    return 'application/octet-stream';
  default: {
    const _ex: never = classification;
    throw new Error(`Unhandled file classification for MIME type: ${JSON.stringify(_ex)}`);
  }
  }
}

export function formatFileMimeEncoding({
  classification,
}: {
  classification: FileCommandClassification,
}): string {
  switch (classification.kind) {
  case 'json':
  case 'xml':
  case 'svg':
  case 'html':
  case 'script':
  case 'ascii_text':
  case 'extended_ascii_text':
  case 'utf8_text':
  case 'utf16_text':
    return classification.text.encoding;
  case 'directory':
  case 'fifo':
  case 'symlink':
  case 'empty':
  case 'binary':
  case 'data':
    return 'binary';
  default: {
    const _ex: never = classification;
    throw new Error(`Unhandled file classification for MIME encoding: ${JSON.stringify(_ex)}`);
  }
  }
}

export function formatFileMime({
  classification,
}: {
  classification: FileCommandClassification,
}): string {
  if (classification.kind === 'symlink' && classification.broken) {
    return formatFileMimeType({ classification });
  }
  return `${formatFileMimeType({ classification })}; charset=${formatFileMimeEncoding({ classification })}`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
