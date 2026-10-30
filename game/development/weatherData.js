import { fetchJson } from '../prototype/safeFetch.js';

const MAX_HOURS = 62 * 24;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validTime = value => typeof value === 'string' && ISO_TIME.test(value) && Number.isFinite(Date.parse(`${value}Z`));

function validNumber(name, value) {
  if (value === null) return true; // Open-Meteo uses null for unavailable observations.
  if (!finite(value)) return false;
  if (name.startsWith('wind_direction_')) return value >= 0 && value <= 360;
  if (name.startsWith('wind_speed_') || name.startsWith('wind_gusts_')) return value >= 0 && value <= 150;
  if (name === 'pressure_msl') return value >= 800 && value <= 1100;
  if (name.startsWith('temperature_') || name.startsWith('dew_point_')) return value >= -120 && value <= 80;
  if (name.startsWith('relative_humidity_') || name === 'cloud_cover') return value >= 0 && value <= 100;
  if (name.startsWith('geopotential_height_')) return value >= -1000 && value <= 50000;
  if (name === 'weather_code') return Number.isInteger(value) && value >= 0 && value <= 99;
  return value >= 0 && value <= 1e7;
}

/** Validate the fields actually requested before indexing or rendering their values. */
export function validateWeatherData(data, requested = {}) {
  if (!record(data)) return false;
  if (data.elevation !== undefined && (!finite(data.elevation) || data.elevation < -1000 || data.elevation > 10000)) return false;
  for (const group of ['hourly', 'daily']) {
    const fields = requested[group] || [];
    if (!fields.length) continue;
    const values = data[group];
    if (!record(values) || !Array.isArray(values.time) || !values.time.length || values.time.length > (group === 'hourly' ? MAX_HOURS : 62)) return false;
    if (!values.time.every(group === 'hourly' ? validTime : value => typeof value === 'string' && ISO_DATE.test(value) && Number.isFinite(Date.parse(value)))) return false;
    for (const name of fields) {
      const series = values[name];
      if (!Array.isArray(series) || series.length !== values.time.length) return false;
      if (!series.every(value => name === 'sunrise' || name === 'sunset' ? validTime(value) : validNumber(name, value))) return false;
    }
  }
  if (requested.current?.length) {
    if (!record(data.current) || !validTime(data.current.time)) return false;
    if (!requested.current.every(name => data.current[name] !== undefined && validNumber(name, data.current[name]))) return false;
  }
  return true;
}

const pending = new Map();
let active = 0;
const queue = [];
function pump() {
  while (active < 3 && queue.length) {
    active++;
    const { run, resolve, reject } = queue.shift();
    run().then(resolve, reject).finally(() => { active--; pump(); });
  }
}

/** Share duplicate in-flight requests, bound concurrency, and retain no API cache. */
export function fetchWeather(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.hostname !== 'api.open-meteo.com' || url.pathname !== '/v1/forecast' || url.username || url.password || url.port) {
    return Promise.reject(new Error('許可されていない気象データ取得先です'));
  }
  const key = url.href;
  if (pending.has(key)) return pending.get(key);
  if (pending.size >= 16) return Promise.reject(new Error('気象データの取得中です。しばらく待ってください'));
  const requested = Object.fromEntries(['hourly', 'daily', 'current'].map(name => [name, (url.searchParams.get(name) || '').split(',').filter(Boolean)]));
  const operation = new Promise((resolve, reject) => {
    queue.push({ resolve, reject, run: () => fetchJson(key, {
      timeoutMs: 20000, maxBytes: 2 * 1024 * 1024,
      validate: data => validateWeatherData(data, requested),
    }) });
    pump();
  }).finally(() => pending.delete(key));
  pending.set(key, operation);
  return operation;
}
