export const fileExplorer__entry_info = ({ name, kind, size, path }: { name: string; kind: string; size: string; path: string }): string => `${name}\n종류: ${kind}\n크기: ${size}\n경로: ${path}`;
