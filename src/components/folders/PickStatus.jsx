import { formErrorClass } from '../shared/formStyles';
import { BTN } from '../settings/pillStyles';
import { PICK_AGAIN, PICK_WAITING, STOP_WAITING } from '../../constants/folders';

/**
 * The line under a folder button while the app's window is open, and the problem after it closed. Rendered
 * for `usePickFlow` state. `again` problems (a refused folder) offer another pick.
 * @param {{ flow: { waiting: boolean, problem: { message: string, again: boolean }|null },
 *   onStop: () => void, onAgain: () => void }} props
 */
export default function PickStatus({ flow, onStop, onAgain }) {
  return (
    <>
      {flow.waiting && (
        <div className="flex basis-full flex-wrap items-center gap-3">
          <p role="status" className="text-sm text-slate-slate300">
            {PICK_WAITING}
          </p>
          <button type="button" onClick={onStop} className={BTN}>
            {STOP_WAITING}
          </button>
        </div>
      )}
      {flow.problem && (
        <div className="flex basis-full flex-wrap items-center gap-3">
          <p role="alert" className={formErrorClass}>
            {flow.problem.message}
          </p>
          {flow.problem.again && (
            <button type="button" onClick={onAgain} className={BTN}>
              {PICK_AGAIN}
            </button>
          )}
        </div>
      )}
    </>
  );
}
