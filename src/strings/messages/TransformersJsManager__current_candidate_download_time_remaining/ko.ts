export const TransformersJsManager__current_candidate_download_time_remaining = ({ seconds }: { seconds: number }): string => {
  if (seconds >= 3600) return `현재 후보 다운로드: 약 ${Math.ceil(seconds / 3600)}시간 남음`;
  if (seconds >= 60) return `현재 후보 다운로드: 약 ${Math.ceil(seconds / 60)}분 남음`;
  return `현재 후보 다운로드: 약 ${Math.max(5, Math.ceil(seconds / 5) * 5)}초 남음`;
};
