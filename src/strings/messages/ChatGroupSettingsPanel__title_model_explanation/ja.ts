export const ChatGroupSettingsPanel__title_model_explanation = ({ inheritedState }: { inheritedState: string | undefined }): string => {
  const description = 'タイトルモデルは、新しいチャットの最初のユーザーメッセージを要約します。';
  return inheritedState === undefined ? description : `${description}現在はグローバル設定の「${inheritedState}」を継承しています。`;
};
