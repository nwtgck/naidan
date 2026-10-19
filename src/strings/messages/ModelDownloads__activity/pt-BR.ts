export const ModelDownloads__activity = ({ active, queued }: { active: number; queued: number }): string => `${active} baixando · ${queued} aguardando`;
