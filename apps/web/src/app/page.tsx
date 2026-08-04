const NAV_SECTIONS = [
  { name: "Timeline", status: "critical" },
  { name: "Devices", status: "critical" },
  { name: "Screenshots", status: "critical" },
  { name: "Reports", status: "high" },
  { name: "Device Inventory", status: "medium" },
] as const;

export default function DashboardPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <h1 className="text-2xl font-semibold">AEMS Admin Dashboard</h1>
      <p className="mt-2 text-slate-600">
        Connects to the API at <code>{process.env.NEXT_PUBLIC_API_URL}</code>.
      </p>
      <ul className="mt-8 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
        {NAV_SECTIONS.map((section) => (
          <li key={section.name} className="flex items-center justify-between px-4 py-3">
            <span>{section.name}</span>
            <span className="text-xs uppercase tracking-wide text-slate-400">{section.status}</span>
          </li>
        ))}
      </ul>
    </main>
  );
}
