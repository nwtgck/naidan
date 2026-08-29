export const volumes__file_progress = ({ processed, total }: { processed: number; total: number }): string => `${processed} / ${total} ${total === 1 ? 'archivo' : 'archivos'}`;
