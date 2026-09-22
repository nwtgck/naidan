export const TransformersJsManager__current_candidate_download_time_remaining = ({ seconds }: { seconds: number }): string => {
  if (seconds >= 3600) return `Current candidate download: about ${Math.ceil(seconds / 3600)} h remaining`;
  if (seconds >= 60) return `Current candidate download: about ${Math.ceil(seconds / 60)} min remaining`;
  return `Current candidate download: about ${Math.max(5, Math.ceil(seconds / 5) * 5)} sec remaining`;
};
