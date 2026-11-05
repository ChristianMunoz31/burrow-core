import { useAppInfo } from '../../hooks/useAppInfo';

const LINK =
  'underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:[outline-color:var(--focus-ring)]';
const CORE_URL = 'https://github.com/ChristianMunoz31/burrow-core';
const RELEASES_URL = 'https://github.com/ChristianMunoz31/burrow-releases/releases/latest';
const HASH_COMMAND = 'Get-FileHash .\\Burrow-Setup-x64.exe -Algorithm SHA256';

/**
 * Plain-language steps for checking Burrow's privacy claims without trusting it. Steps 2 and 3 are for the
 * desktop app, so they show only when /api/app/info says desktop. The dev channel uses its own process name.
 */
export default function VerifyYourself() {
  const { info } = useAppInfo();
  const desktop = info?.desktop === true;
  const serverName = info?.channel === 'dev' ? 'burrow-dev-server.exe' : 'burrow-server.exe';
  return (
    <div className="space-y-3 text-sm text-slate-slate300">
      <p className="text-xs text-slate-slate400">
        You don&apos;t have to take our word for it. These checks work on your own computer.
      </p>
      <ol className="list-decimal space-y-3 pl-5">
        <li>
          <p className="font-semibold text-slate-slate100">Turn off Wi-Fi</p>
          <p>
            Turn off Wi-Fi (or unplug the network cable) and use Burrow as usual. Everything keeps working, except features that
            obviously need the internet, like weather or update checks, which you turned on yourself.
          </p>
        </li>
        {desktop && (
          <li>
            <p className="font-semibold text-slate-slate100">Watch the connections</p>
            <p>
              On Windows, open Resource Monitor, go to the Network tab and find <span className="font-mono">{serverName}</span>,
              Burrow&apos;s local server. It only talks to <span className="font-mono">127.0.0.1</span>, which is your computer and
              nothing else, unless you turned on a feature like weather or update checks. You can also add a Windows Defender
              Firewall rule for it.
            </p>
            <p>
              If you click Download and install for an update, the Burrow app (
              <span className="font-mono">Burrow.exe</span>, not the local server) connects to{' '}
              <span className="font-mono">github.com</span> and GitHub&apos;s download servers (
              <span className="font-mono">release-assets.githubusercontent.com</span>,{' '}
              <span className="font-mono">objects.githubusercontent.com</span>) to get the installer, and only after that click. The Burrow window uses <span className="font-mono">msedgewebview2.exe</span>, a part of Windows
              that other apps share, so connections from that name are not a reliable sign of what Burrow does.
            </p>
          </li>
        )}
        {desktop && (
          <li>
            <p className="font-semibold text-slate-slate100">Check your download</p>
            <p>
              Each release has a <span className="font-mono">SHA256SUMS.txt</span> file with the expected checksum of both installers.
              Download it from{' '}
              <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className={LINK}>
                the latest release page
              </a>
              . Then open PowerShell in the folder with the installer and run:
            </p>
            <pre className="glass-subtle mt-1 overflow-x-auto rounded-md p-2 text-xs">{HASH_COMMAND}</pre>
            <p className="mt-1">
              Use <span className="font-mono">Burrow-Setup-arm64.exe</span> if you downloaded the ARM installer. The hash must match the
              line for your file in <span className="font-mono">SHA256SUMS.txt</span>. If it does not match, delete the file and
              download it again. Updates installed from inside Burrow are checked against Burrow&apos;s signing key before they run; a
              file that fails the check is never installed.
            </p>
          </li>
        )}
        {!desktop && (
          <li className="list-none text-xs text-slate-slate400">These steps are for the desktop app.</li>
        )}
        <li value={desktop ? 4 : 2}>
          <p className="font-semibold text-slate-slate100">See what Burrow connected to</p>
          <p>
            Open Network activity in this section to see the connections Burrow made: the feature, the website, the time and the result. A Buy Burrow Pro link opens the store page in your browser, so it is not a Burrow connection.
          </p>
        </li>
      </ol>
      <p>
        The source of Burrow&apos;s core is public under AGPL-3.0-only at{' '}
        <a href={CORE_URL} target="_blank" rel="noopener noreferrer" className={LINK}>
          github.com/ChristianMunoz31/burrow-core
        </a>
        . Pro features are a private module.
      </p>
    </div>
  );
}
