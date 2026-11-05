import BookmarksPage from '../components/bookmarks/BookmarksPage';

export default function Bookmarks() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h2 className="text-xl font-bold text-slate-slate100 tracking-tight">Bookmarks</h2>
        <p className="text-sm text-slate-slate400 mt-1">
          Quick links to the sites and docs you reach for, grouped.
        </p>
      </div>
      <BookmarksPage />
    </div>
  );
}
