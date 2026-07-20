import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTimeSlots,
  timeSlotsFromRange,
} from "../lib/time-slots.mjs";
import { validateScheduleArc } from "../lib/schedule-validation.mjs";
import { applyLifeArcOps } from "../lib/world-state.mjs";

const denyPolicy = {
  light: { allow: false },
  medium: { allow: false },
  heavy: { allow: "school_only" },
  minGapBetweenEventsMinutes: 60,
};

test("time slots are derived in JST rather than the host time zone", () => {
  assert.deepEqual(
    timeSlotsFromRange("2026-07-03T15:00:00+09:00", "2026-07-03T17:00:00+09:00"),
    [{ date: "2026-07-03", start: "15:00", end: "17:00" }],
  );
});

test("multi-day envelopes derive repeated daily windows only with a per-day duration", () => {
  assert.equal(
    timeSlotsFromRange("2026-07-08T09:00:00+09:00", "2026-07-11T17:00:00+09:00"),
    null,
  );
  assert.deepEqual(
    timeSlotsFromRange(
      "2026-07-08T09:00:00+09:00",
      "2026-07-11T17:00:00+09:00",
      { durationHours: 8 },
    ),
    [
      { date: "2026-07-08", start: "09:00", end: "17:00" },
      { date: "2026-07-09", start: "09:00", end: "17:00" },
      { date: "2026-07-10", start: "09:00", end: "17:00" },
      { date: "2026-07-11", start: "09:00", end: "17:00" },
    ],
  );
});

test("invalid or inverted clock ranges are rejected during normalization", () => {
  assert.equal(normalizeTimeSlots([
    { date: "2026-07-03", start: "25:00", end: "26:00" },
    { date: "2026-07-03", start: "17:00", end: "15:00" },
    { date: "2026-02-31", start: "09:00", end: "10:00" },
  ]), null);
});

test("recurring slots can carry date-specific absences", () => {
  const slots = normalizeTimeSlots([{
    dayOfWeek: 5,
    start: "13:10",
    end: "14:40",
    excluded_dates: ["2026-07-03", "bad-date", "2026-07-03"],
  }]);
  assert.deepEqual(slots, [{
    dayOfWeek: 5,
    start: "13:10",
    end: "14:40",
    excludedDates: ["2026-07-03"],
  }]);
  const result = validateScheduleArc({
    title: "Friday recording",
    kind: "work",
    timeStart: "2026-07-03T15:00:00+09:00",
    timeEnd: "2026-07-03T17:00:00+09:00",
    timeSlots: [{ date: "2026-07-03", start: "15:00", end: "17:00" }],
    durationHours: 2,
  }, [{
    id: "school",
    title: "Friday class",
    kind: "school",
    status: "active",
    timeStart: "2026-04-01T00:00:00+09:00",
    timeEnd: "2026-07-31T23:59:59+09:00",
    timeSlots: slots,
  }], { conflictPolicy: denyPolicy, workHoursPerDay: 8 });
  assert.equal(result.valid, true);
});

test("shared validator blocks overlap and an insufficient travel gap", () => {
  const existing = [{
    id: "existing",
    title: "Existing",
    kind: "work",
    status: "active",
    timeStart: "2026-07-03T13:00:00+09:00",
    timeEnd: "2026-07-03T15:00:00+09:00",
    timeSlots: [{ date: "2026-07-03", start: "13:00", end: "15:00" }],
    durationHours: 2,
  }];
  const overlap = validateScheduleArc({
    title: "Overlap",
    kind: "work",
    timeStart: "2026-07-03T14:00:00+09:00",
    timeEnd: "2026-07-03T16:00:00+09:00",
    timeSlots: [{ date: "2026-07-03", start: "14:00", end: "16:00" }],
    durationHours: 2,
  }, existing, { conflictPolicy: denyPolicy, workHoursPerDay: 8 });
  assert.equal(overlap.valid, false);
  assert.ok(overlap.errors.some(error => error.startsWith("time_conflict:")));

  const shortGap = validateScheduleArc({
    title: "Short gap",
    kind: "work",
    timeStart: "2026-07-03T15:30:00+09:00",
    timeEnd: "2026-07-03T17:00:00+09:00",
    timeSlots: [{ date: "2026-07-03", start: "15:30", end: "17:00" }],
    durationHours: 1.5,
  }, existing, { conflictPolicy: denyPolicy, workHoursPerDay: 8 });
  assert.equal(shortGap.valid, false);
  assert.ok(shortGap.errors.some(error => error.startsWith("insufficient_gap:")));
});

test("heavy work may overlap school under school_only policy", () => {
  const result = validateScheduleArc({
    title: "Four-day shoot",
    kind: "work",
    timeStart: "2026-07-08T09:00:00+09:00",
    timeEnd: "2026-07-11T17:00:00+09:00",
    timeSlots: [
      { date: "2026-07-08", start: "09:00", end: "17:00" },
      { date: "2026-07-09", start: "09:00", end: "17:00" },
      { date: "2026-07-10", start: "09:00", end: "17:00" },
      { date: "2026-07-11", start: "09:00", end: "17:00" },
    ],
    durationHours: 8,
  }, [{
    id: "school",
    title: "Friday class",
    kind: "school",
    status: "active",
    timeStart: "2026-04-01T00:00:00+09:00",
    timeEnd: "2026-07-31T23:59:59+09:00",
    timeSlots: [{ dayOfWeek: 5, start: "13:10", end: "14:40" }],
  }], { conflictPolicy: denyPolicy, workHoursPerDay: 8 });
  assert.equal(result.valid, true);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].allowed, true);
});

test("durationHours is treated as per-day work rather than divided across a range", () => {
  const result = validateScheduleArc({
    title: "Candidate",
    kind: "work",
    timeStart: "2026-07-08T12:00:00+09:00",
    timeEnd: "2026-07-09T17:00:00+09:00",
    timeSlots: [
      { date: "2026-07-08", start: "12:00", end: "17:00" },
      { date: "2026-07-09", start: "12:00", end: "17:00" },
    ],
    durationHours: 5,
  }, [{
    id: "existing",
    title: "Existing",
    kind: "work",
    status: "active",
    timeStart: "2026-07-08T07:00:00+09:00",
    timeEnd: "2026-07-09T11:00:00+09:00",
    timeSlots: [
      { date: "2026-07-08", start: "07:00", end: "11:00" },
      { date: "2026-07-09", start: "07:00", end: "11:00" },
    ],
    durationHours: 4,
  }], { conflictPolicy: denyPolicy, workHoursPerDay: 8 });
  assert.equal(result.valid, false);
  assert.deepEqual(result.density.map(item => item.totalHours), [9, 9]);
});

test("world-state derives slots on create and recomputes them after timing updates", () => {
  const roleWorld = { profile: "默认", _lifeArcs: [] };
  const options = {
    workEventConfig: {
      conflictPolicy: denyPolicy,
      workHoursPerDay: 8,
    },
  };
  const created = applyLifeArcOps(roleWorld, [{
    op: "create",
    title: "Recording",
    summary: "Test",
    kind: "work",
    time_start: "2026-07-22T09:00:00+09:00",
    time_end: "2026-07-22T11:00:00+09:00",
    time_slots: null,
    duration_hours: 2,
  }], options);
  assert.equal(created.applied, 1);
  assert.deepEqual(roleWorld._lifeArcs[0].timeSlots, [
    { date: "2026-07-22", start: "09:00", end: "11:00" },
  ]);

  const updated = applyLifeArcOps(roleWorld, [{
    op: "update",
    id: roleWorld._lifeArcs[0].id,
    time_start: "2026-07-22T13:00:00+09:00",
    time_end: "2026-07-22T15:30:00+09:00",
    duration_hours: 2.5,
  }], options);
  assert.equal(updated.applied, 1);
  assert.deepEqual(roleWorld._lifeArcs[0].timeSlots, [
    { date: "2026-07-22", start: "13:00", end: "15:30" },
  ]);
});

test("life arcs preserve model-generated chat texture across updates", () => {
  const roleWorld = { profile: "默认", _lifeArcs: [] };
  const options = {
    workEventConfig: {
      conflictPolicy: denyPolicy,
      workHoursPerDay: 8,
    },
  };
  const created = applyLifeArcOps(roleWorld, [{
    op: "create",
    title: "Osaka promo",
    summary: "Two-day promo event",
    kind: "work",
    time_start: "2026-07-24T09:00:00+09:00",
    time_end: "2026-07-24T11:00:00+09:00",
    duration_hours: 2,
    life_texture: {
      current_life_texture: "明天一早要去大阪宣传新曲，今晚主要是行李和台本。",
      concrete_chatable_details: ["新干线时间比较早", "衣服和台本要提前确认"],
      private_pressure: "早起和转场会有点赶。",
      mood_residue: "有一点紧，但不是坏事。",
      what_not_to_say: ["不要完整播报行程"],
      proactive_sendability: "low",
    },
  }], options);
  assert.equal(created.applied, 1);
  assert.equal(roleWorld._lifeArcs[0].lifeTexture.currentLifeTexture, "明天一早要去大阪宣传新曲，今晚主要是行李和台本。");
  assert.deepEqual(roleWorld._lifeArcs[0].lifeTexture.concreteChatableDetails, ["新干线时间比较早", "衣服和台本要提前确认"]);
  assert.equal(roleWorld._lifeArcs[0].lifeTexture.proactiveSendability, "low");

  const updated = applyLifeArcOps(roleWorld, [{
    op: "update",
    id: roleWorld._lifeArcs[0].id,
    progress_note: "Packed half of the outfit list",
  }], options);
  assert.equal(updated.applied, 1);
  assert.equal(roleWorld._lifeArcs[0].lifeTexture.currentLifeTexture, "明天一早要去大阪宣传新曲，今晚主要是行李和台本。");
});
