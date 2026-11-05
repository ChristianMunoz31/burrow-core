import TodosPage from '../components/todos/TodosPage';

export default function Todos() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h2 className="text-xl font-bold text-slate-slate100 tracking-tight">Todos</h2>
        <p className="text-sm text-slate-slate400 mt-1">Drag cards between columns, or mark them done.</p>
      </div>
      <TodosPage />
    </div>
  );
}
