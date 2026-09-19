export const TransformersJsManager__about_time_remaining = ({ seconds }: { seconds: number }): string => {
  if (seconds >= 3600) return `About ${Math.ceil(seconds / 3600)} h remaining`;
  if (seconds >= 60) return `About ${Math.ceil(seconds / 60)} min remaining`;
  return `About ${Math.max(5, Math.ceil(seconds / 5) * 5)} sec remaining`;
};
