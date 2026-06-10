// weather.mjs — 实时天气数据获取与 prompt 注入
// 使用 Open-Meteo 免费 API（无需 Key），获取东京 + 上海双城实时天气，
// 通过内存缓存（30 分钟 TTL）避免频繁请求，失败时降级为空字符串。

// WMO 天气代码 → 中文描述
const WMO_DESC = {
  0: "晴", 1: "大部晴", 2: "多云", 3: "阴",
  45: "雾", 48: "雾凇",
  51: "小毛毛雨", 53: "中毛毛雨", 55: "大毛毛雨",
  56: "小冻毛毛雨", 57: "大冻毛毛雨",
  61: "小雨", 63: "中雨", 65: "大雨",
  66: "小冻雨", 67: "大冻雨",
  71: "小雪", 73: "中雪", 75: "大雪",
  77: "雪粒",
  80: "小阵雨", 81: "中阵雨", 82: "大阵雨",
  85: "小阵雪", 86: "大阵雪",
  95: "雷暴", 96: "小冰雹雷暴", 99: "大冰雹雷暴",
};

const LOCATIONS = {
  tokyo:    { lat: 35.68, lon: 139.76, tz: "Asia/Tokyo",    label: "东京（角色侧）" },
  shanghai: { lat: 31.23, lon: 121.47, tz: "Asia/Shanghai", label: "上海（用户侧）" },
};

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟
const FETCH_TIMEOUT_MS = 5000;

let _cache = null; // { at, data }

async function fetchOne(key, loc) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,precipitation_probability&timezone=${encodeURIComponent(loc.tz)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return { ...loc, current: json.current };
}

async function fetchWeatherData() {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.data;
  try {
    const entries = await Promise.all(Object.entries(LOCATIONS).map(([k, loc]) => fetchOne(k, loc)));
    const data = Object.fromEntries(entries.map((e, i) => [Object.keys(LOCATIONS)[i], e]));
    _cache = { at: Date.now(), data };
    return data;
  } catch (_e) {
    if (_cache) return _cache.data; // 降级到过期缓存
    return null;                    // 彻底无数据，返回 null（调用方处理为空字符串）
  }
}

// formatWeatherReality —— 将天气数据格式化为 prompt 注入文本
// 参数：weatherData - fetchWeatherData 的返回值
// 返回：格式化的天气描述字符串；null/空对象返回空字符串
export function formatWeatherReality(weatherData) {
  if (!weatherData) return "";
  const lines = ["【当前天气】"];
  for (const [key, data] of Object.entries(weatherData)) {
    if (!data?.current) continue;
    const c = data.current;
    const desc = WMO_DESC[c.weather_code] ?? `气象码${c.weather_code}`;
    const precip = c.precipitation_probability != null ? `降水概率 ${c.precipitation_probability}%` : "";
    const parts = [
      `${data.label}：${c.temperature_2m}°C，${desc}`,
      `湿度 ${c.relative_humidity_2m}%`,
      `体感 ${c.apparent_temperature}°C`,
      precip,
    ].filter(Boolean);
    lines.push(parts.join("，"));
  }
  lines.push("", "（以上为实时天气数据，若与月份季节描述冲突，以实时数据为准）");
  return lines.join("\n");
}

// getWeatherReality —— 获取天气数据并格式化为 prompt 文本（异步便捷方法）
// 返回：格式化天气字符串，获取失败时返回空字符串
export async function getWeatherReality() {
  let data;
  try {
    data = await fetchWeatherData();
  } catch (_e) {
    data = null;
  }
  return formatWeatherReality(data);
}
