import { useLicense } from '../../hooks/useLicense';
import { LINK_BTN } from '../settings/pillStyles';

/**
 * The "Buy Burrow Pro" link: a plain anchor to the store product page from `status.purchaseUrl`
 * (config/store.json). In the desktop app the shell cancels the navigation and opens it in the default
 * browser (src-tauri/src/nav.rs), so it is not a Burrow network request. Renders nothing while the
 * status is unknown, when no https URL is configured, or when a license is stored on this computer
 * (any license record, including an ended one: those users renew or get a new key, not a new purchase).
 * `allowLicensed` keeps it for a Store license that does not include the feature asked for (a newer license is a new purchase).
 * `className` replaces the default button style when a placement needs a quieter one.
 */
export default function BuyProLink({ className = LINK_BTN, allowLicensed = false }) {
  const { status } = useLicense();
  const href = status?.purchaseUrl;
  if (typeof href !== 'string' || !/^https:\/\//i.test(href)) return null;
  if (!allowLicensed && (status.license || status.proSource === 'license' || status.licenseState === 'pro')) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      Buy Burrow Pro<span className="sr-only"> (opens in your browser)</span>
    </a>
  );
}
