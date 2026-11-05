import JournalPage from '../components/journal/JournalPage';

export default function Journal() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h2 className="text-xl font-bold text-slate-slate100 tracking-tight">Journal</h2>
        <p className="text-sm text-slate-slate400 mt-1">
          Speak or type your thoughts. Stats update as you go.
        </p>
      </div>
      <JournalPage />
    </div>
  );
}
