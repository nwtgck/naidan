/** Paths are data, never URLs. Preserve Unicode/spaces; reject traversal by segment. */
export function validModelPath({ path }: { path: string }): boolean {
  return path.length > 0 && path.length <= 8192 && path.split('/').length <= 64 && new TextDecoder().decode(new TextEncoder().encode(path)) === path && !path.includes('\\') && !Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && new TextEncoder().encode(part).length <= 255);
}
export function relativeCompanionPath({ indexPath, reference }: { indexPath: string, reference: string }): string {
  if (!validModelPath({ path: indexPath }) || !validModelPath({ path: reference }) || reference.includes(':')) throw new Error('Unsafe local model companion path');
  const parent = indexPath.split('/').slice(0, -1).join('/');
  return parent ? `${parent}/${reference}` : reference;
}
export const TEST_ONLY = {
};
