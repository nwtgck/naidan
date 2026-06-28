export const fileExplorer__entry_info = ({ name, kind, size, path }: { name: string; kind: string; size: string; path: string }): string => `${name}\nKind: ${kind}\nSize: ${size}\nPath: ${path}`;
