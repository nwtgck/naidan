export const CspMessageHint__this_submission_destination_is_outside_the_allowed_range = ({ url }: { url: string | undefined }): string => (
  `この送信先${url === undefined ? '' : `（${url}）`}は、この許可範囲に含まれていません。`
);
