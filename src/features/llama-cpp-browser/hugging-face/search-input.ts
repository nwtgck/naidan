/** Only an explicit Hugging Face HTTPS URL bypasses model search.
 * Repository-like text (including slashes and variant suffixes) is deliberately
 * not parsed here: it may be a partial search, not an exact repository ID.
 * Path/variant validation remains the direct repository action's responsibility. */
export function huggingFaceUrl({ input }: { input: string }): string | undefined {
  const value = input.trim();
  if (!value.toLowerCase().startsWith('https://')) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['huggingface.co', 'hf.co'].includes(url.hostname) || url.port || url.username || url.password) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

export const TEST_ONLY = {
};
