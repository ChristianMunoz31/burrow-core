import { reportContentHref } from './reportContent';

/**
 * Small "Report" link under a Javi reply. It is a plain mailto link, so the shell hands it to the
 * default mail app. The link never contains the reply text; the user chooses what to paste.
 * @param {{ className?: string, label?: string }} props
 */
export default function ReportLink({ className = '', label = 'Report this Javi reply by email' }) {
  return (
    <a
      href={reportContentHref()}
      aria-label={label}
      title="Opens your mail app with an empty report. Nothing is sent automatically."
      className={`max-sm:inline-flex max-sm:min-h-6 max-sm:items-center text-[11px] text-slate-slate300 underline hover:text-slate-slate100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-slateBlueLight ${className}`}
    >
      Report
    </a>
  );
}
