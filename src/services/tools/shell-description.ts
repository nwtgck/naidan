import type { WeshMount } from '@/services/wesh/types';

export interface FileTypeHint {
  example: string;
}

export const FILE_TYPE_HINTS: Record<string, FileTypeHint> = {
  '.docx': { example: 'unzip example.docx -d /tmp/example' },
  '.xlsx': { example: 'unzip example.xlsx -d /tmp/example' },
  '.pptx': { example: 'unzip example.pptx -d /tmp/example' },
};

function formatExtList(exts: string[]): string {
  if (exts.length === 1) return exts[0]!;
  if (exts.length === 2) return `${exts[0]} and ${exts[1]}`;
  return `${exts.slice(0, -1).join(', ')}, and ${exts.at(-1)}`;
}

export function buildShellDescription({
  mounts,
  detectedExtensions,
}: {
  mounts: WeshMount[];
  detectedExtensions: Set<string>;
}): string {
  const mountList =
    mounts.length > 0
      ? `\n\nMounted directories:\n${mounts.map(m => `- ${m.path} (${m.readOnly ? 'read-only' : 'read-write'})`).join('\n')}`
      : '';

  const knownExts = [...detectedExtensions].filter(ext => ext in FILE_TYPE_HINTS);

  let fileTypeSection = '';
  if (knownExts.length > 0) {
    const extList = formatExtList(knownExts);
    const examples = knownExts.map(ext => `  ${FILE_TYPE_HINTS[ext]!.example}`).join('\n');
    fileTypeSection = `\n\nTo read ${extList} files in the mounts, unzip them to /tmp first:\n${examples}`;
  }

  return (
    'Execute shell scripts to perform file operations, system exploration, and data processing. ' +
    'You can use standard Unix-like commands (ls, cat, grep, etc.). Run `help` to see available utilities.' +
    mountList +
    fileTypeSection
  );
}
