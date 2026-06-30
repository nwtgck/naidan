export const fileExplorer__entry_info = ({ name, kind, size, path }: { name: string; kind: string; size: string; path: string }): string => `${name}\n種類: ${kind}\nサイズ: ${size}\nパス: ${path}`;
