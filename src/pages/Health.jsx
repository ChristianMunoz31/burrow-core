import HealthPage from '../components/health/HealthPage';

export default function Health() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h2 className="text-xl font-bold text-slate-slate100 tracking-tight">Sleep &amp; activity</h2>
        <p className="text-sm text-slate-slate400 mt-1">
          Readiness, sleep, and activity from your Oura Ring.
        </p>
      </div>
      <HealthPage />
    </div>
  );
}
