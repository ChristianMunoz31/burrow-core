import { useMutation } from '@tanstack/react-query';
import { updateService } from '../services/updateService';

/**
 * The two click-only update actions. `install(version)` resolves once the server saved a backup and passed the request
 * to the desktop app; `getInstaller(version)` resolves with the pinned download link and its SHA-256. Both reject with
 * an error whose `code` names the refusal.
 */
export function useUpdateInstall() {
  const install = useMutation({ mutationFn: (version) => updateService.install(version) });
  const getInstaller = useMutation({ mutationFn: (version) => updateService.manual(version) });
  return { install: install.mutateAsync, getInstaller: getInstaller.mutateAsync };
}
