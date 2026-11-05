import { useAppInfo } from '../../hooks/useAppInfo';
import { formatBuildIdentity } from '../../utils/buildIdentity';
import { SETTINGS_EXTENSIONS } from '../../extensions/settingsExtensions';

/**
 * Always-visible build identity at the bottom of Settings; renders nothing when the app info has no usable part.
 * Names the developer tools when a build-contributed Settings section shows (none in a stable build).
 * A second line names the data folder in use (support needs it), when the server says where it is.
 */
export default function BuildIdentityLine() {
  const { info } = useAppInfo();
  const line = formatBuildIdentity(info, { devTools: SETTINGS_EXTENSIONS.some((ext) => ext.enabled(info)) });
  const dataDir = typeof info?.dataDir === 'string' && info.dataDir.trim() ? info.dataDir.trim() : null;
  if (!line && !dataDir) return null;
  return (
    <div className="text-center text-xs text-slate-slate400">
      {line && <p data-testid="build-identity">{line}</p>}
      {dataDir && <p data-testid="data-folder-identity">Data folder: {dataDir}</p>}
    </div>
  );
}
