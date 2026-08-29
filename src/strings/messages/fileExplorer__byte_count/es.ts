export const fileExplorer__byte_count = ({ count }: { count: number }): string => `${count.toLocaleString()} ${count === 1 ? 'byte' : 'bytes'}`;
