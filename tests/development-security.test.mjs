import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWeatherData } from '../game/development/weatherData.js';

test('weather validation accepts requested bounded numeric series and missing observations', () => {
  const data = { elevation: 15, hourly: { time: ['2026-10-25T07:00', '2026-10-25T08:00'], wind_speed_10m: [3, null], wind_direction_10m: [360, 0] } };
  assert.equal(validateWeatherData(data, { hourly: ['wind_speed_10m', 'wind_direction_10m'] }), true);
});

test('weather validation rejects injected strings, missing series, invalid sizes and out-of-range data', () => {
  const valid = { hourly: { time: ['2026-10-25T07:00'], wind_speed_10m: [3] } };
  const expected = { hourly: ['wind_speed_10m'] };
  for (const bad of ['<img src=x onerror=alert(1)>', Infinity, NaN, -1, 151, {}, []]) {
    const data = structuredClone(valid);
    data.hourly.wind_speed_10m[0] = bad;
    assert.equal(validateWeatherData(data, expected), false);
  }
  assert.equal(validateWeatherData({ hourly: { time: valid.hourly.time } }, expected), false);
  assert.equal(validateWeatherData({ hourly: { time: valid.hourly.time, wind_speed_10m: [] } }, expected), false);
  assert.equal(validateWeatherData({ hourly: { time: Array(1489).fill('2026-10-25T07:00'), wind_speed_10m: Array(1489).fill(3) } }, expected), false);
  assert.equal(validateWeatherData({ hourly: { time: ['<script>'], wind_speed_10m: [3] } }, expected), false);
});

test('daily/current weather fields are validated before use', () => {
  assert.equal(validateWeatherData({ daily: { time: ['2026-10-25'], sunrise: ['2026-10-25T06:00'], sunset: ['2026-10-25T17:00'] } }, { daily: ['sunrise', 'sunset'] }), true);
  assert.equal(validateWeatherData({ current: { time: '2026-10-25T07:00', pressure_msl: 1013 } }, { current: ['pressure_msl'] }), true);
  assert.equal(validateWeatherData({ current: { time: '2026-10-25T07:00', pressure_msl: '1013' } }, { current: ['pressure_msl'] }), false);
  assert.equal(validateWeatherData({ daily: { time: ['2026-10-25'], sunrise: ['<img>'] } }, { daily: ['sunrise'] }), false);
});
