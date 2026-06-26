export const MessageItem__image_missing = ({ fileName, fileSize }: { fileName: string; fileSize: string }): string => (
  `Image missing (${fileName}) - ${fileSize}`
);
