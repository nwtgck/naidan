export const TransformersJsManager__about_time_remaining = ({ seconds }: { seconds: number }): string => {
  if (seconds >= 3600) return `预计剩余 ${Math.ceil(seconds / 3600)} 小时`;
  if (seconds >= 60) return `预计剩余 ${Math.ceil(seconds / 60)} 分钟`;
  return `预计剩余 ${Math.max(5, Math.ceil(seconds / 5) * 5)} 秒`;
};
