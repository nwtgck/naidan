export const ChatSettingsPanel__title_model_explanation = ({ inheritedState, source }: { inheritedState: string | undefined; source: string | undefined }): string => {
  const description = 'The title model is used only once to summarize the first user message.';
  return inheritedState === undefined ? description : `${description} Currently inheriting ${inheritedState} from ${source}.`;
};
