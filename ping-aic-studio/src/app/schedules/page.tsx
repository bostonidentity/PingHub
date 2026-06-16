import { ScheduleList } from "./ScheduleList";

export const dynamic = "force-dynamic";

export default function SchedulesPage() {
  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">Schedules</h1>
      <ScheduleList />
    </main>
  );
}
