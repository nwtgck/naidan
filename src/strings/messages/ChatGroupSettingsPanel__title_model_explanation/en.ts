export const ChatGroupSettingsPanel__title_model_explanation = ({ inheritedState }: { inheritedState: string | undefined }): string => {
  const description = 'The title model is used to summarize the first user message in new chats.';
  return inheritedState === undefined ? description : `${description} Currently inheriting ${inheritedState} from Global Settings.`;
};
