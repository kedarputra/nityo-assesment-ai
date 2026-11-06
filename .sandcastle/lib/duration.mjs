// A time span as a person reads it: "45 min", "3 h 12 min". Seconds are dropped,
// since "11531s" says nothing at a glance.

/** `seconds` in minutes, or hours and minutes past 60 minutes. "" for no value. */
export function duration(seconds) {
  if (seconds === undefined || seconds === null) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "under 1 min";
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
