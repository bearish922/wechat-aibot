import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatWeatherReality } from "../lib/weather.mjs";

describe("weather prompt context", () => {
  it("keeps live weather as background instead of a mandatory reply topic", () => {
    const text = formatWeatherReality({
      shanghai: {
        label: "上海（用户侧）",
        current: {
          temperature_2m: 24,
          relative_humidity_2m: 80,
          apparent_temperature: 25,
          weather_code: 61,
          precipitation_probability: 70,
        },
      },
    });

    assert.match(text, /只用于约束场景/);
    assert.match(text, /不要因为看见这段数据就在回复中主动提醒天气/);
    assert.match(text, /近期对话已经提过时尤其不要重复/);
  });
});
