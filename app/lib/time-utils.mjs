// time-utils.mjs — 零依赖时区工具
// 整个代码库不使用 UTC（toISOString），系统/用户侧用北京时间 (+08:00)，角色侧用东京时间 (+09:00)

function formatISO(date, timeZone, offset) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(date).filter(x => x.type !== "literal").map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

export function beijingISO(date = new Date()) {
  return formatISO(date, "Asia/Shanghai", "+08:00");
}

export function tokyoISO(date = new Date()) {
  return formatISO(date, "Asia/Tokyo", "+09:00");
}

export function formatZonedTimeParts(date = new Date(), timeZone = "Asia/Shanghai") {
  const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const shortWeekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  const weekdayValue = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayValue);
  const hour = Number(parts.hour || 0);
  const stamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  const timePeriodFromHour = (h) => {
    if (h < 5) return "凌晨";
    if (h < 8) return "早上";
    if (h < 11) return "上午";
    if (h < 13) return "中午";
    if (h < 18) return "下午";
    if (h < 23) return "晚上";
    return "深夜";
  };
  return {
    stamp, weekday: weekdays[weekdayIndex] || weekdays[date.getDay()],
    shortWeekday: shortWeekdays[weekdayIndex] || shortWeekdays[date.getDay()],
    period: timePeriodFromHour(hour), timeZone,
  };
}
