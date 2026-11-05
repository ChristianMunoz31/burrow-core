import { Suspense, lazy, useRef, useState } from 'react';
import { BTN } from './pillStyles';

// The dialog (and its copy) only loads when someone asks to erase.
const EraseDataDialog = lazy(() => import('./EraseDataDialog'));

export default function DangerZone() {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  return (
    <section id="danger-zone" aria-labelledby="danger-zone-title" className="rounded-lg border border-red-500/40 p-4">
      <h4 id="danger-zone-title" className="text-sm font-semibold text-accent-red">
        Danger zone
      </h4>
      <p className="mt-1 text-xs text-slate-slate400">
        Erase all my data permanently deletes everything you saved in Burrow on this computer. Kept: your license
        (unless you remove it), your Pro trial status, and your backups (unless you delete them too). This cannot be
        undone.
      </p>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(true)}
        className={`${BTN} mt-3 !text-accent-red`}
      >
        Erase all my data
      </button>
      {open && (
        <Suspense fallback={null}>
          <EraseDataDialog onClose={() => setOpen(false)} finalFocusRef={trigger} />
        </Suspense>
      )}
    </section>
  );
}
