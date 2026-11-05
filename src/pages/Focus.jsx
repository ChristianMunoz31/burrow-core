import FocusPage from '../components/focus/FocusPage';

export default function Focus() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h2 className="text-xl font-bold text-slate-slate100 tracking-tight">Focus</h2>
        <p className="text-sm text-slate-slate400 mt-1">
          A Pomodoro timer that logs your focus sessions so you can see today&apos;s deep work.
        </p>
      </div>
      <FocusPage />
    </div>
  );
}
