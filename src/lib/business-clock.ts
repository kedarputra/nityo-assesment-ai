// Harbor Point's clock. Every `received_at` in the data pack carries -05:00, US Eastern in
// November, so times are shown there whatever the server's or the browser's own zone.
const BUSINESS_TIME_ZONE = "America/New_York";

const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
});

// "07:26"
export function formatBusinessTime(moment: Date): string {
  return timeFormat.format(moment);
}

// "Mon 2 Nov"
export function formatBusinessDay(moment: Date): string {
  return dayFormat.format(moment);
}

// en-CA writes dates as ISO "2026-11-02".
const isoDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// The calendar day a moment falls on at Harbor Point: an email's order date (policy 1).
export function businessDateOf(moment: Date): string {
  return isoDateFormat.format(moment);
}
