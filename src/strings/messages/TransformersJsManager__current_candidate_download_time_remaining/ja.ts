export const TransformersJsManager__current_candidate_download_time_remaining = ({ seconds }: { seconds: number }): string => {
  if (seconds >= 3600) return `現在の候補のダウンロード残り約${Math.ceil(seconds / 3600)}時間`;
  if (seconds >= 60) return `現在の候補のダウンロード残り約${Math.ceil(seconds / 60)}分`;
  return `現在の候補のダウンロード残り約${Math.max(5, Math.ceil(seconds / 5) * 5)}秒`;
};
