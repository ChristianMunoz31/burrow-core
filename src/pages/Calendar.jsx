import CalendarPage from '../components/calendar/CalendarPage';

// Calendar: events and .ics import. The forecast is not here: it shows in the Javi card on Home.
export default function Calendar() {
  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-5">
        <h2 className="text-xl font-bold text-slate-slate100 tracking-tight">Calendar</h2>
        <p className="text-sm text-slate-slate400 mt-1">Your events. Add events or import an .ics file.</p>
      </div>
      <CalendarPage />
    </div>
  );
}
