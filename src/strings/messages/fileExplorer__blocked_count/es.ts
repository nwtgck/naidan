export const fileExplorer__blocked_count = ({ count }: { count: number }): string => `${count.toLocaleString()} ${count === 1 ? 'bloqueado' : 'bloqueados'}`;
