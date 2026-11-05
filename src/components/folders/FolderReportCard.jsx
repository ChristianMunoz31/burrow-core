import { Suspense } from 'react';
import { FolderReportWriter } from '../../extensions/proExtensions';
import { isFreeUi, useEntitlements } from '../../hooks/useEntitlements';
import ProGateNotice from '../license/ProGateNotice';
import { REPORT_HEADING, formatDate } from '../../constants/folders';

/**
 * The cross-file report of one folder (themes, related files, things worth a look). Everyone can read a report that
 * exists; writing a new one is Pro and lives in the Pro module's writer. Without Pro, or in a build without the
 * Pro module, the panel shows the upgrade notice. The text is plain.
 * @param {{ folder: object, busy: boolean }} props
 */
export default function FolderReportCard({ folder, busy }) {
  const entitlements = useEntitlements();
  const gated = isFreeUi(entitlements, 'folder_report') || !FolderReportWriter;
  const label = `${REPORT_HEADING}: ${folder.name}`;
  const report = folder.report;
  return (
    <section aria-label={label} className="space-y-2">
      {report?.text && (
        <>
          <p className="whitespace-pre-wrap text-sm text-slate-slate100">{report.text}</p>
          {report.at && <p className="text-xs text-slate-slate400">Written {formatDate(report.at)}.</p>}
        </>
      )}
      {gated ? (
        <ProGateNotice capability="folder_report" />
      ) : (
        <Suspense fallback={null}>
          <FolderReportWriter folder={folder} busy={busy} />
        </Suspense>
      )}
    </section>
  );
}
