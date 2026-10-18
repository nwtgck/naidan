import type { LocalModel } from './types';

/** Derive a chat-group name from the file identity, not its shortened UI alias. */
export function localModelChatGroupName({ model }: { model: LocalModel }): string {
  let path = model.source?.path;
  if (path === undefined && /^(?:hf\.co|host)\//i.test(model.id)) {
    const separator = model.id.indexOf(':');
    if (separator !== -1) {
      try {
        path = decodeURIComponent(model.id.slice(separator + 1));
      } catch {
        // A malformed encoded locator must not prevent using its display name.
      }
    }
  }
  const fallback = model.name.split(/[\\/]/).at(-1) || model.name;
  const filename = (path ?? model.name).split(/[\\/]/).at(-1) || fallback;
  // Single-file imports already remove .gguf before appending -GGUF to the
  // folder name. Remove one format suffix without trimming the original stem.
  const stem = /^user\//i.test(model.id) && /-GGUF$/i.test(filename)
    ? filename.slice(0, -'-GGUF'.length)
    : filename.replace(/\.gguf$/i, '');
  return stem.replace(/-\d{5}-of-\d{5}$/i, '') || fallback;
}

export const TEST_ONLY = {
};
