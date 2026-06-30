export const MessageItem__image_missing = ({ fileName, fileSize }: { fileName: string; fileSize: string }): string => (
  `画像が見つかりません（${fileName}）- ${fileSize}`
);
