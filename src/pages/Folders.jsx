import FoldersPage from '../components/folders/FoldersPage';
import { FOLDERS_SUBTITLE, FOLDERS_TITLE } from '../constants/folders';

export default function Folders() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h2 className="text-xl font-bold text-slate-slate100 tracking-tight">{FOLDERS_TITLE}</h2>
        <p className="text-sm text-slate-slate400 mt-1">{FOLDERS_SUBTITLE}</p>
      </div>
      <FoldersPage />
    </div>
  );
}
