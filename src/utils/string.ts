export function capitalize({ value }: { value: string }) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function naturalSort({ values }: { values: readonly string[] }): string[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...values].sort(collator.compare);
}

/**
 * Sanitizes a string for use as a filename.
 * Replaces invalid characters, normalizes whitespace, and truncates to 255 bytes
 * (UTF-8) including the suffix and an ellipsis if truncated.
 *
 * If the resulting base is empty after sanitization, the provided fallback is used.
 */
export function sanitizeFilename({ base, suffix, fallback }: {
  base: string,
  suffix: string,
  fallback: string,
}): string {
  // 1. Remove invalid OS characters and normalize whitespace
  let cleanBase = base
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  // If the resulting base is empty or just dashes, use fallback
  if (!cleanBase || /^-+$/.test(cleanBase)) cleanBase = fallback;

  // 2. Handle truncation if necessary
  const ext = suffix;
  const ellipsis = '...';
  const MAX_BYTES = 255;

  const encoder = new TextEncoder();
  const getByteLength = ({ value }: { value: string }) => encoder.encode(value).length;

  const fullPath = cleanBase + ext;
  if (getByteLength({ value: fullPath }) <= MAX_BYTES) {
    return fullPath;
  }

  // Truncate base to account for suffix and ellipsis
  const availableBytesForBase = MAX_BYTES - getByteLength({ value: ellipsis }) - getByteLength({ value: ext });

  if (availableBytesForBase <= 0) {
    // No room for base + ellipsis. Truncate from the total combined string.
    const chars = Array.from(fullPath);
    let result = '';
    for (const char of chars) {
      if (getByteLength({ value: result + char }) <= MAX_BYTES) {
        result += char;
      } else {
        break;
      }
    }
    return result;
  }

  // Binary search for the longest safe base
  const baseChars = Array.from(cleanBase);
  let low = 0;
  let high = baseChars.length;
  let bestBase = '';

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const testBase = baseChars.slice(0, mid).join('');
    if (getByteLength({ value: testBase }) <= availableBytesForBase) {
      bestBase = testBase;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return bestBase.trimEnd() + ellipsis + ext;
}
