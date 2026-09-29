// time.ts — local time, written down the way the records want it.
//
// Copied from scholion-places (E:\scholion-places\time.ts), unchanged. Both
// functions work in the machine's timezone rather than UTC: a page captured
// at half past midnight belongs to that day locally, and the clipping's
// <YYYY-MM> folder is a question about local months, not UTC ones.

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Today, locally, as YYYY-MM-DD. */
export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Now, locally, as an ISO 8601 timestamp carrying its offset. */
export function localTimestamp(now = new Date()): string {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);

  return (
    `${localDate(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}
