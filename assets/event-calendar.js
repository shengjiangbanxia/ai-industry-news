(function (root) {
  const DAY = 86400000;
  function beijingDate(now = new Date()) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  }
  function dayNumber(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) / DAY : NaN;
  }
  function groupEvents(events, asOf = beijingDate()) {
    const today = dayNumber(asOf);
    const result = { upcoming: [], recent: [], pending: [] };
    for (const source of events) {
      const event = { ...source };
      const start = dayNumber(event.start_date);
      const end = dayNumber(event.end_date || event.start_date);
      if (["cancelled", "rumored"].includes(event.status)) continue;
      event.days_remaining = Number.isFinite(start) ? start - today : null;
      if (Number.isFinite(end) && end < today && end >= today - 30) {
        event.status = "completed";
        result.recent.push(event);
      } else if (event.status === "confirmed" && Number.isFinite(start) && end >= today) {
        event.ongoing = start <= today;
        result.upcoming.push(event);
      } else if (!Number.isFinite(start) && event.priority === "core") result.pending.push(event);
    }
    result.upcoming.sort((a, b) => dayNumber(a.start_date) - dayNumber(b.start_date));
    result.recent.sort((a, b) => dayNumber(b.end_date || b.start_date) - dayNumber(a.end_date || a.start_date));
    return result;
  }
  const api = { groupEvents, beijingDate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EventCalendar = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
