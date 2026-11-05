import NotesPage from '../components/notes/NotesPage';

export default function Notes() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h2 className="text-xl font-bold text-slate-slate100 tracking-tight">Notes</h2>
        <p className="text-sm text-slate-slate400 mt-1">
          Quick sticky notes, tagged work or home. Pin the ones that matter.
        </p>
      </div>
      <NotesPage />
    </div>
  );
}
