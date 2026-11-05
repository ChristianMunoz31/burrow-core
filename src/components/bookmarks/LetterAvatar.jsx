import { Bookmark } from 'lucide-react';
import { hostnameOf, hueForHost } from './url';

/**
 * Local site avatar: the first letter of the bookmark's hostname on a color derived
 * from the hostname. No network request, unlike a favicon service.
 */
export default function LetterAvatar({ url }) {
  const host = hostnameOf(url);
  if (!host) {
    return <Bookmark size={16} aria-hidden="true" className="shrink-0 text-slate-slate500" />;
  }
  const hue = hueForHost(host);
  return (
    <span
      aria-hidden="true"
      data-testid="letter-avatar"
      style={{ backgroundColor: `hsl(${hue} 55% 38%)` }}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[10px] font-bold uppercase leading-none text-white"
    >
      {host.charAt(0)}
    </span>
  );
}
