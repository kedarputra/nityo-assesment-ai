"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setScheduleAction } from "@/server/desk/actions";

const INTERVALS = [5, 10, 15, 30, 60] as const;

export function ScheduleForm({ enabled, intervalMinutes }: { enabled: boolean; intervalMinutes: number }) {
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [every, setEvery] = useState(intervalMinutes);
  const [notice, setNotice] = useState<{ text: string; problem: boolean } | null>(null);
  const [saving, startSaving] = useTransition();

  return (
    <form
      className="schedule-form"
      onSubmit={(event) => {
        event.preventDefault();
        setNotice(null);
        startSaving(async () => {
          const result = await setScheduleAction({ enabled: on, intervalMinutes: every });
          setNotice(result.ok ? { text: "Schedule saved.", problem: false } : { text: result.message, problem: true });
          router.refresh();
        });
      }}
    >
      <label className="switch">
        <input type="checkbox" role="switch" checked={on} onChange={(event) => setOn(event.target.checked)} />
        <span>Run the agent automatically</span>
      </label>
      <label className="field">
        Every
        <select value={every} onChange={(event) => setEvery(Number(event.target.value))} disabled={!on}>
          {INTERVALS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} minutes
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn btn--primary" disabled={saving} aria-busy={saving}>
        Save schedule
      </button>
      <p className={notice?.problem ? "inline-error" : "meta"} role="status" aria-live="polite" hidden={!notice}>
        {notice?.text}
      </p>
    </form>
  );
}
