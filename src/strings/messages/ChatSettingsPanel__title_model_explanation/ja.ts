export const ChatSettingsPanel__title_model_explanation = ({ inheritedState, source }: { inheritedState: string | undefined; source: string | undefined }): string => {
  const description = 'タイトルモデルは最初のユーザーメッセージを一度だけ要約するために使用されます。';
  return inheritedState === undefined ? description : `${description} 現在は${source}の「${inheritedState}」を継承しています。`;
};
