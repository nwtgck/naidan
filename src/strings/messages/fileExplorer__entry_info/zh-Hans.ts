export const fileExplorer__entry_info = ({ name, kind, size, path }: { name: string; kind: string; size: string; path: string }): string => `${name}\n类型：${kind}\n大小：${size}\n路径：${path}`;
