import {
  calendarDateRange,
  normalizeTimeSlots,
  slotDurationHours,
  slotGapMinutes,
  slotMatchesDate,
  slotsOverlap,
  timeSlotsFromRange,
  zonedParts,
} from "./time-slots.mjs";

function field(raw, camel, snake) {
  return raw?.[camel] ?? raw?.[snake];
}

function scheduleView(raw = {}) {
  const timeStart = field(raw, "timeStart", "time_start") || null;
  const timeEnd = field(raw, "timeEnd", "time_end") || null;
  const durationRaw = field(raw, "durationHours", "duration_hours");
  const durationHours = Number(durationRaw) > 0 ? Number(durationRaw) : null;
  const rawSlots = field(raw, "timeSlots", "time_slots");
  const explicitSlots = normalizeTimeSlots(rawSlots);
  return {
    id: raw.id ? String(raw.id) : "",
    title: String(raw.title || "").trim(),
    kind: raw.kind || null,
    status: raw.status || "active",
    timeStart,
    timeEnd,
    rawSlots,
    timeSlots: explicitSlots || timeSlotsFromRange(timeStart, timeEnd, { durationHours }),
    durationHours,
  };
}

function scheduleScale(arc) {
  const start = zonedParts(arc.timeStart);
  const end = zonedParts(arc.timeEnd);
  const days = start && end ? calendarDateRange(start.date, end.date).length : 1;
  if ((arc.durationHours || 0) >= 8 || days > 1) return "heavy";
  if ((arc.durationHours || 0) >= 4) return "medium";
  return "light";
}

function policyAllowsConflict(policy, scale, existingKind) {
  const allow = policy?.[scale]?.allow ?? false;
  return allow === true || (allow === "school_only" && existingKind === "school");
}

function slotLabel(slot) {
  return `${slot.date || `weekly-${slot.dayOfWeek}`} ${slot.start}-${slot.end}`;
}

function dailyHoursForArc(arc, dateKey) {
  if (arc.kind !== "work") return 0;
  const matching = (arc.timeSlots || []).filter(slot => slotMatchesDate(slot, dateKey));
  if (!matching.length) return 0;
  if (arc.durationHours) return arc.durationHours;
  return matching.reduce((sum, slot) => sum + slotDurationHours(slot), 0);
}

function validateScheduleArc(rawCandidate, rawExistingArcs = [], options = {}) {
  const candidate = scheduleView(rawCandidate);
  const existingArcs = (rawExistingArcs || [])
    .map(scheduleView)
    .filter(arc => arc.status !== "closed" && (!candidate.id || arc.id !== candidate.id));
  const policy = options.conflictPolicy || {};
  const minGapMinutes = options.minGapMinutes ?? policy.minGapBetweenEventsMinutes ?? 0;
  const workHoursPerDay = Number(options.workHoursPerDay || 8);
  const errors = [];
  const warnings = [];

  if (!candidate.title) errors.push("missing_title");
  if (!candidate.kind) errors.push("missing_kind");
  const start = candidate.timeStart ? new Date(candidate.timeStart) : null;
  const end = candidate.timeEnd ? new Date(candidate.timeEnd) : null;
  if (!start || !Number.isFinite(start.getTime()) || !end || !Number.isFinite(end.getTime())) {
    errors.push("invalid_time_range");
  } else if (end <= start) {
    errors.push("time_end_not_after_start");
  }

  if (
    Array.isArray(candidate.rawSlots)
    && candidate.rawSlots.length
    && (!candidate.timeSlots || candidate.timeSlots.length !== candidate.rawSlots.length)
  ) {
    errors.push("invalid_time_slots");
  }
  if (!candidate.timeSlots?.length) errors.push("missing_time_slots");

  const startJst = start && Number.isFinite(start.getTime()) ? zonedParts(start) : null;
  const endJst = end && Number.isFinite(end.getTime()) ? zonedParts(end) : null;
  if (startJst && endJst && candidate.timeSlots?.length) {
    for (const slot of candidate.timeSlots) {
      if (slot.date && (slot.date < startJst.date || slot.date > endJst.date)) {
        errors.push(`time_slot_outside_envelope:${slotLabel(slot)}`);
      }
    }
  }

  const scale = scheduleScale(candidate);
  const conflicts = [];
  const gaps = [];
  for (const existing of existingArcs) {
    if (!existing.timeSlots?.length || !candidate.timeSlots?.length) continue;
    const conflictAllowed = policyAllowsConflict(policy, scale, existing.kind);
    for (const candidateSlot of candidate.timeSlots) {
      for (const existingSlot of existing.timeSlots) {
        if (slotsOverlap(candidateSlot, existingSlot)) {
          conflicts.push({
            existingId: existing.id,
            existingTitle: existing.title || "untitled",
            existingKind: existing.kind,
            candidateSlot,
            existingSlot,
            allowed: conflictAllowed,
          });
          continue;
        }
        const gap = slotGapMinutes(candidateSlot, existingSlot);
        if (!conflictAllowed && minGapMinutes > 0 && gap !== null && gap < minGapMinutes) {
          gaps.push({
            existingId: existing.id,
            existingTitle: existing.title || "untitled",
            candidateSlot,
            existingSlot,
            gap,
          });
        }
      }
    }
  }

  const blockedConflicts = conflicts.filter(item => !item.allowed);
  for (const item of blockedConflicts) {
    errors.push(
      `time_conflict:${slotLabel(item.candidateSlot)}:${item.existingTitle}:${slotLabel(item.existingSlot)}`,
    );
  }
  for (const item of gaps) {
    errors.push(
      `insufficient_gap:${slotLabel(item.candidateSlot)}:${item.existingTitle}:${item.gap}m`,
    );
  }

  const density = [];
  if (candidate.kind === "work" && candidate.timeSlots?.some(slot => slot.date)) {
    const candidateDates = [...new Set(candidate.timeSlots.filter(slot => slot.date).map(slot => slot.date))];
    for (const date of candidateDates) {
      const ownHours = dailyHoursForArc(candidate, date);
      const existingHours = existingArcs.reduce((sum, arc) => sum + dailyHoursForArc(arc, date), 0);
      const totalHours = ownHours + existingHours;
      if (totalHours > workHoursPerDay) {
        density.push({ date, ownHours, existingHours, totalHours, limit: workHoursPerDay });
        errors.push(`daily_work_density:${date}:${totalHours.toFixed(1)}h>${workHoursPerDay}h`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    scale,
    timeSlots: candidate.timeSlots,
    conflicts,
    gaps,
    density,
  };
}

function auditScheduleArcs(rawArcs = [], options = {}) {
  return (rawArcs || [])
    .filter(raw => raw?.status !== "closed")
    .map(raw => ({
      id: raw.id || "",
      title: raw.title || "",
      ...validateScheduleArc(raw, rawArcs, options),
    }));
}

export {
  scheduleView,
  scheduleScale,
  validateScheduleArc,
  auditScheduleArcs,
};
