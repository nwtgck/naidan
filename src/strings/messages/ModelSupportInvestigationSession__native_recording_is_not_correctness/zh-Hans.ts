export const ModelSupportInvestigationSession__native_recording_is_not_correctness = ({ recording }: { recording: 'not-recorded' | 'partial' | 'recorded' }): string => {
  const labels = {"not-recorded":"未保留内部记录","partial":"记录存在明确缺失","recorded":"在限定记录中未发现其他缺失"};
  return `内部记录：${labels[recording]}。记录和已完成的请求不能证明回答正确或可完整重现。`;
};
