import { probeRuntimeProfiles } from './detect-profile';

declare const self: Pick<Worker, 'postMessage'>;

void probeRuntimeProfiles().then(({ recommended }) => {

  self.postMessage(recommended);
}, () => {

  self.postMessage(undefined);
});

export const TEST_ONLY = {
};
