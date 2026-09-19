export const ModelSupportInvestigationSession__fresh_metadata_preparation_status = ({ status }: { status: 'running' | 'prepared' | 'failed' | 'timeout' | 'interrupted' | 'not-run' | 'not-recorded' }): string => {
  switch (status) {
  case 'running': return "Fresh metadata preparation: running";
  case 'prepared': return "Fresh metadata preparation: succeeded";
  case 'failed': return "Fresh metadata preparation: failed";
  case 'timeout': return "Fresh metadata preparation: timed out";
  case 'interrupted': return "Fresh metadata preparation: interrupted";
  case 'not-run': return "Fresh metadata preparation: not run";
  case 'not-recorded': return "Fresh metadata preparation: not recorded";
  default: {
    const exhaustive: never = status;
    throw new Error(`Unhandled fresh metadata status: ${exhaustive}`);
  }
  }
};
