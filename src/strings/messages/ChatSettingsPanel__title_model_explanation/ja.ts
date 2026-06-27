export const ChatSettingsPanel__title_model_explanation = ({ inheritedState, source }: { inheritedState: string | undefined; source: string | undefined }): string => {
  const description = 'タイトルモデルは、最初のユーザーメッセージを一度だけ要約します。';
  return inheritedState === undefined ? description : `${description}現在は${source}の「${inheritedState}」を継承しています。`;
};
