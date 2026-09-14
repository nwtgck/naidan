export const TransformersJsManager__about_time_remaining = ({ seconds }: { seconds: number }): string => {
  if (seconds >= 3600) return `残り約${Math.ceil(seconds / 3600)}時間`;
  if (seconds >= 60) return `残り約${Math.ceil(seconds / 60)}分`;
  return `残り約${Math.max(5, Math.ceil(seconds / 5) * 5)}秒`;
};
