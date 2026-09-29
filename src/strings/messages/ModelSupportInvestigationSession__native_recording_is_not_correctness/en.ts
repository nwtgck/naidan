export const ModelSupportInvestigationSession__native_recording_is_not_correctness = ({ recording }: { recording: 'not-recorded' | 'partial' | 'recorded' }): string => {
  const labels = {"not-recorded":"No retained native record","partial":"Recorded with explicit gaps","recorded":"No additional gaps detected in the bounded record"};
  return `Native recording: ${labels[recording]}. Recording and fulfilled requests do not certify response correctness or complete replay.`;
};
