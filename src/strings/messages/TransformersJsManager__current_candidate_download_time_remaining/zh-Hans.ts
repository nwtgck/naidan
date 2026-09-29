export const TransformersJsManager__current_candidate_download_time_remaining = ({ seconds }: { seconds: number }): string => {
  if (seconds >= 3600) return `当前候选项下载：约剩 ${Math.ceil(seconds / 3600)} 小时`;
  if (seconds >= 60) return `当前候选项下载：约剩 ${Math.ceil(seconds / 60)} 分钟`;
  return `当前候选项下载：约剩 ${Math.max(5, Math.ceil(seconds / 5) * 5)} 秒`;
};
