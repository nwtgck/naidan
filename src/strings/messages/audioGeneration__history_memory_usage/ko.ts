export const audioGeneration__history_memory_usage = ({ count, mebibytes }: { count: number, mebibytes: string }): string => `${count}개 · 음성 데이터 ${mebibytes} MiB (재생용 메모리 별도)`;
