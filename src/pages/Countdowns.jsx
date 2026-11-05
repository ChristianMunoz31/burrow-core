import CountdownsPage from '../components/countdowns/CountdownsPage';

export default function Countdowns() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h2 className="text-xl font-bold text-slate-slate100 tracking-tight">Countdowns</h2>
        <p className="text-sm text-slate-slate400 mt-1">
          Track the days until deadlines, launches, birthdays, and trips.
        </p>
      </div>
      <CountdownsPage />
    </div>
  );
}
