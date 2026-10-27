export const CspMessageHint__this_submission_destination_is_outside_the_allowed_range = ({ url }: { url: string | undefined }): string => (
  `This submission destination${url === undefined ? '' : ` (${url})`} is outside the allowed range.`
);
