export const fileExplorer__overwrite_count = ({ count }: { count: number }): string => `${count.toLocaleString()} ${count === 1 ? 'sobrescritura' : 'sobrescrituras'}`;
