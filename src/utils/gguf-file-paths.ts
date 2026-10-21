/** Parse the conventional GGUF split suffix while preserving stem and extension. */
export function parseGgufSplitPath({ relativePath }: { relativePath: string }): { stem: string, index: number, count: number, extension: string } | undefined {
  const match = /^(.*)-([0-9]{5})-of-([0-9]{5})(\.gguf)$/i.exec(relativePath);
  return match ? { stem: match[1]!, index: Number(match[2]), count: Number(match[3]), extension: match[4]! } : undefined;
}

export const TEST_ONLY = {
};
