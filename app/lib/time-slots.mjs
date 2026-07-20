const TOKYO_TIME_ZONE = "Asia/Tokyo";

function zonedParts(value, timeZone = TOKYO_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find(part => part.type === type)?.value || "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${hour}:${get("minute")}`,
  };
}

function clockMinutes(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function minutesClock(value) {
  if (!Number.isFinite(value) || value < 0 || value > 24 * 60) return null;
  if (value === 24 * 60) return "24:00";
  const hour = Math.floor(value / 60);
  const minute = value % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function addCalendarDays(dateKey, count) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + count, 12))
    .toISOString()
    .slice(0, 10);
}

function isCalendarDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function calendarDateRange(startDate, endDate, maxDays = 366) {
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate)) return [];
  const result = [];
  let current = startDate;
  while (current <= endDate && result.length < maxDays) {
    result.push(current);
    current = addCalendarDays(current, 1);
  }
  return result;
}

function jstDayOfWeek(dateKey) {
  const date = new Date(`${dateKey}T12:00:00+09:00`);
  if (!Number.isFinite(date.getTime())) return null;
  const day = date.getUTCDay();
  return day === 0 ? 7 : day;
}

function normalizeTimeSlots(rawSlots) {
  if (!Array.isArray(rawSlots) || !rawSlots.length) return null;
  const normalized = [];
  const seen = new Set();
  for (const raw of rawSlots) {
    if (!raw || typeof raw !== "object") continue;
    const date = raw.date && isCalendarDate(String(raw.date).trim().slice(0, 10))
      ? String(raw.date).trim().slice(0, 10)
      : null;
    const dayRaw = raw.dayOfWeek ?? raw.day_of_week;
    const dayOfWeek = Number.isInteger(Number(dayRaw)) && Number(dayRaw) >= 1 && Number(dayRaw) <= 7
      ? Number(dayRaw)
      : null;
    const start = String(raw.start || "").trim().slice(0, 5);
    const end = String(raw.end || "").trim().slice(0, 5);
    const startMinutes = clockMinutes(start);
    const endMinutes = clockMinutes(end);
    if ((!date && !dayOfWeek) || startMinutes === null || endMinutes === null || endMinutes <= startMinutes) continue;
    const excludedDates = !date && Array.isArray(raw.excludedDates || raw.excluded_dates)
      ? [...new Set((raw.excludedDates || raw.excluded_dates)
        .map(value => String(value || "").slice(0, 10))
        .filter(isCalendarDate))]
        .sort()
      : [];
    const slot = date
      ? { date, start, end }
      : {
          dayOfWeek,
          start,
          end,
          ...(excludedDates.length ? { excludedDates } : {}),
        };
    const key = JSON.stringify(slot);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(slot);
  }
  normalized.sort((a, b) => {
    const aKey = a.date || `weekly-${a.dayOfWeek}`;
    const bKey = b.date || `weekly-${b.dayOfWeek}`;
    return aKey.localeCompare(bKey) || a.start.localeCompare(b.start) || a.end.localeCompare(b.end);
  });
  return normalized.length ? normalized : null;
}

function timeSlotsFromRange(timeStart, timeEnd, { durationHours = null } = {}) {
  if (!timeStart || !timeEnd) return null;
  const start = new Date(timeStart);
  const end = new Date(timeEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return null;
  const startJst = zonedParts(start);
  const endJst = zonedParts(end);
  if (!startJst || !endJst) return null;
  if (startJst.date === endJst.date) {
    return normalizeTimeSlots([{ date: startJst.date, start: startJst.time, end: endJst.time }]);
  }

  // A multi-day range is only an envelope. Derive daily occupied windows when
  // an explicit per-day duration is available; otherwise require time_slots.
  const dailyMinutes = Number(durationHours) > 0 ? Math.round(Number(durationHours) * 60) : 0;
  const startMinutes = clockMinutes(startJst.time);
  if (!dailyMinutes || startMinutes === null || startMinutes + dailyMinutes > 24 * 60) return null;
  const dailyEnd = minutesClock(startMinutes + dailyMinutes);
  if (!dailyEnd || dailyEnd === "24:00") return null;
  return normalizeTimeSlots(
    calendarDateRange(startJst.date, endJst.date, 31)
      .map(date => ({ date, start: startJst.time, end: dailyEnd })),
  );
}

function slotMatchesDate(slot, dateKey) {
  if (!slot || !dateKey) return false;
  if (slot.date) return slot.date === dateKey;
  if (slot.dayOfWeek) {
    if (slot.excludedDates?.includes(dateKey)) return false;
    return slot.dayOfWeek === jstDayOfWeek(dateKey);
  }
  return false;
}

function slotsCanShareDate(left, right) {
  if (left.date && right.date) return left.date === right.date;
  if (left.date && right.dayOfWeek) return slotMatchesDate(right, left.date);
  if (right.date && left.dayOfWeek) return slotMatchesDate(left, right.date);
  return Boolean(left.dayOfWeek && right.dayOfWeek && left.dayOfWeek === right.dayOfWeek);
}

function slotsOverlap(left, right) {
  if (!slotsCanShareDate(left, right)) return false;
  const leftStart = clockMinutes(left.start);
  const leftEnd = clockMinutes(left.end);
  const rightStart = clockMinutes(right.start);
  const rightEnd = clockMinutes(right.end);
  return leftStart < rightEnd && rightStart < leftEnd;
}

function slotGapMinutes(left, right) {
  if (!slotsCanShareDate(left, right) || slotsOverlap(left, right)) return null;
  const leftStart = clockMinutes(left.start);
  const leftEnd = clockMinutes(left.end);
  const rightStart = clockMinutes(right.start);
  const rightEnd = clockMinutes(right.end);
  if ([leftStart, leftEnd, rightStart, rightEnd].some(value => value === null)) return null;
  return leftStart >= rightEnd ? leftStart - rightEnd : rightStart - leftEnd;
}

function slotDurationHours(slot) {
  const start = clockMinutes(slot?.start);
  const end = clockMinutes(slot?.end);
  return start === null || end === null || end <= start ? 0 : (end - start) / 60;
}

export {
  TOKYO_TIME_ZONE,
  zonedParts,
  clockMinutes,
  isCalendarDate,
  calendarDateRange,
  jstDayOfWeek,
  normalizeTimeSlots,
  timeSlotsFromRange,
  slotMatchesDate,
  slotsCanShareDate,
  slotsOverlap,
  slotGapMinutes,
  slotDurationHours,
};
