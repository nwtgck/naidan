export const volumes__active_count = ({ count }: { count: number }): string => `${count} ${count === 1 ? 'ativo' : 'ativos'}`;
