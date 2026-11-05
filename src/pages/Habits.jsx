import HabitsPage from '../components/habits/HabitsPage';

export default function Habits() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h2 className="text-xl font-bold text-slate-slate100 tracking-tight">Habits</h2>
        <p className="text-sm text-slate-slate400 mt-1">
          Daily commitments and 30-day streak grid, saved on this computer.
        </p>
      </div>
      <HabitsPage />
    </div>
  );
}
