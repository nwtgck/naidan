export const ChatGroupSettingsPanel__title_model_explanation = ({ inheritedState }: { inheritedState: string | undefined }): string => {
  const description = 'タイトルモデルは新しいチャットの最初のユーザーメッセージを要約するために使用されます。';
  return inheritedState === undefined ? description : `${description} 現在はグローバル設定の「${inheritedState}」を継承しています。`;
};
