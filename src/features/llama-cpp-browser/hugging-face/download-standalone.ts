// Fetch follows the existing standalone privacy-fetch facade; only Worker
// creation differs. Writer code has no inference runtime dependency.
export { downloadRepository, cancelDownload } from './download';
export const TEST_ONLY = {
};
