// How a customer's words for a delivery date become a date (U11). Code reads the phrase, so a
// requested date is never only the model's reading of it:
//
// - a bare weekday, or "this <weekday>", is its next occurrence after today;
// - "today" is the order date and "tomorrow" the day after;
// - an explicit date ("Nov 6", "October 30", "11/7", "2026-11-12") is that day of the order's year;
// - "next <weekday>" is ambiguous: it could be the coming one or the one a week later, so both
//   are recorded and a person asks;
// - a weekday that disagrees with the date beside it is ambiguous too.
//
// Dates are ISO calendar days ("2026-11-02"), which compare correctly as strings.

export type RequestedDate =
  | { kind: "on"; date: string; past: boolean }
  | { kind: "ambiguous"; dates: [string, string]; reason: string }
  | { kind: "unreadable" };

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Whole names or the usual abbreviations, so "sat" in "satisfied" is not a Saturday.
const weekdayPattern =
  /\b(next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)\b/i;
const isoPattern = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const monthDayPattern = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
const dayMonthPattern = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
const slashPattern = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/;

export function resolveRequestedDate(words: string, today: string): RequestedDate {
  if (/\btoday\b/i.test(words)) return on(today, today);
  if (/\btomorrow\b/i.test(words)) return on(addDays(today, 1), today);

  const explicit = explicitDate(words, Number(today.slice(0, 4)));
  if (explicit === "invalid") return { kind: "unreadable" };
  const weekday = weekdayPattern.exec(words);

  if (explicit) {
    if (weekday) {
      const named = weekdayIndex(weekday[2] ?? "");
      if (named !== dayOfWeek(explicit)) {
        const byWeekday = nextOccurrence(today, named);
        const dates = [byWeekday, explicit].sort() as [string, string];
        return {
          kind: "ambiguous",
          dates,
          reason: `“${words.trim()}”: ${dayMonth(explicit)} is a ${capitalise(WEEKDAYS[dayOfWeek(explicit)] ?? "")}`,
        };
      }
    }
    return on(explicit, today);
  }

  if (!weekday) return { kind: "unreadable" };
  const coming = nextOccurrence(today, weekdayIndex(weekday[2] ?? ""));
  if (weekday[1]?.trim().toLowerCase() === "next") {
    const weekLater = addDays(coming, 7);
    return {
      kind: "ambiguous",
      dates: [coming, weekLater],
      reason: `“${weekday[0]}” could be ${shortDay(coming)} or ${shortDay(weekLater)}`,
    };
  }
  return on(coming, today);
}

function on(date: string, today: string): RequestedDate {
  return { kind: "on", date, past: date < today };
}

// An explicit calendar date in the words, "invalid" when it names a day that does not exist.
function explicitDate(words: string, year: number): string | "invalid" | null {
  const iso = isoPattern.exec(words);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const monthDay = monthDayPattern.exec(words);
  if (monthDay) return calendarDate(year, monthIndex(monthDay[1] ?? "") + 1, Number(monthDay[2]));
  const dayMonth = dayMonthPattern.exec(words);
  if (dayMonth) return calendarDate(year, monthIndex(dayMonth[2] ?? "") + 1, Number(dayMonth[1]));
  // Harbor Point's customers write US dates: month first.
  const slash = slashPattern.exec(words);
  if (slash) return calendarDate(slash[3] ? Number(slash[3]) : year, Number(slash[1]), Number(slash[2]));
  return null;
}

function calendarDate(year: number, month: number, day: number): string | "invalid" {
  const moment = new Date(Date.UTC(year, month - 1, day));
  if (moment.getUTCFullYear() !== year || moment.getUTCMonth() !== month - 1 || moment.getUTCDate() !== day) {
    return "invalid";
  }
  return moment.toISOString().slice(0, 10);
}

function weekdayIndex(word: string): number {
  return WEEKDAYS.findIndex((name) => name.startsWith(word.toLowerCase().slice(0, 3)));
}

function monthIndex(word: string): number {
  return MONTHS.indexOf(word.toLowerCase().slice(0, 3));
}

// The next such weekday strictly after `from`.
function nextOccurrence(from: string, weekday: number): string {
  const ahead = (weekday - dayOfWeek(from) + 7) % 7 || 7;
  return addDays(from, ahead);
}

function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}

function dayMonth(date: string): string {
  const month = MONTHS[Number(date.slice(5, 7)) - 1] ?? "";
  return `${Number(date.slice(8, 10))} ${capitalise(month)}`;
}

// "Tue 3 Nov"
function shortDay(date: string): string {
  return `${capitalise((WEEKDAYS[dayOfWeek(date)] ?? "").slice(0, 3))} ${dayMonth(date)}`;
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
