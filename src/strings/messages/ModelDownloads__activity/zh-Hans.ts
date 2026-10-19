export const ModelDownloads__activity = ({ active, queued }: { active: number; queued: number }): string => `${active} 项正在下载 · ${queued} 项等待中`;
