export const ChatGroupSettingsPanel__title_model_explanation = ({ inheritance }: { inheritance: 'none' | 'enabled' | 'disabled' }): string => {
  const description = 'The title model is used to summarize the first user message in new chats.';
  switch (inheritance) {
  case 'none':
    return description;
  case 'enabled':
    return `${description} Currently inheriting Enabled from Global Settings.`;
  case 'disabled':
    return `${description} Currently inheriting Disabled from Global Settings.`;
  default: {
    const _ex: never = inheritance;
    throw new Error(`Unhandled title model inheritance: ${_ex}`);
  }
  }
};
