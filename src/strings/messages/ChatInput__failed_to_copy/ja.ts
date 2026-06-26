export const ChatInput__failed_to_copy = ({ name, errorMessage }: { name: string; errorMessage: string }): string => (
  `「${name}」をコピーできませんでした: ${errorMessage}`
);
