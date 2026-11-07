export function splitModelName({ name }: { name: string | undefined }): { prefix: string, suffix: string | undefined } {
  if (name === undefined) {
    return { prefix: '', suffix: undefined };
  }
  const lastSlashIndex = name.lastIndexOf('/');
  return { prefix: name.slice(0, lastSlashIndex + 1), suffix: name.slice(lastSlashIndex + 1) };
}

export const TEST_ONLY = {
};
