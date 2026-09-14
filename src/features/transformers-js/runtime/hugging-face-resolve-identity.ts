/** Identity only: this parser does not authorize network access or select resources. */
export function parseHuggingFaceResolveIdentity({ url }: { url: string }): {
  modelId: string;
  revision: string;
  path: string;
} | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'huggingface.co' && !parsed.hostname.endsWith('.huggingface.co')) return undefined;
    const parts = parsed.pathname.split('/');
    // HF model URLs have exactly two repository identity components before
    // the separator. Either component, or a later filename, may be "resolve".
    if (parts.length < 6 || parts[3] !== 'resolve') return undefined;
    const owner = decodeURIComponent(parts[1]!);
    const repository = decodeURIComponent(parts[2]!);
    const revision = decodeURIComponent(parts[4]!);
    const path = parts.slice(5).map(part => decodeURIComponent(part));
    const safeSegment = ({ part }: { part: string }) => part.length > 0 && part !== '.' && part !== '..'
      && !/[\\/]/.test(part)
      && !Array.from(part).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
    // A revision may be an encoded ref (for example refs/pr/1). Its single URL
    // component still fixes the artifact boundary; callers decide exact SHA use.
    if (![owner, repository, ...revision.split('/'), ...path].every(part => safeSegment({ part }))) return undefined;
    return { modelId: `${owner}/${repository}`, revision, path: path.join('/') };
  } catch {
    return undefined;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
