// Shared links and form input are untrusted. Keep validation independent of the DOM
// so the same limits apply when settings are read, edited, and shared again.
export const FLIGHT_LIMITS = Object.freeze({
  queryLength: 4096,
  windRows: 32,
  altitudeFt: 30000,
  windSpeedKt: 150,
});
export const DEFAULT_START_TIME = '07:00';

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
function decimal(text) {
  if (typeof text !== 'string' || text.length > 24 || !DECIMAL.test(text)) return NaN;
  return Number(text);
}

function validArea(area) {
  return area && Number.isFinite(area.lon) && Number.isFinite(area.lat)
    && area.lon >= 122 && area.lon <= 148 && area.lat >= 24 && area.lat <= 46;
}

export function decodeArea(text) {
  if (typeof text !== 'string' || text.length > 49) return null;
  const fields = text.split(',');
  if (fields.length !== 2) return null;
  const area = { lon: decimal(fields[0]), lat: decimal(fields[1]) };
  return validArea(area) ? area : null;
}

// Reject the entire table on an invalid row; silently dropping rows would change
// a shared flight's conditions. Return a fresh, ordered table for the caller.
export function validateWind(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > FLIGHT_LIMITS.windRows) return null;
  const result = [];
  const altitudes = new Set();
  for (const row of rows) {
    if (!row || ![row.ft, row.dir, row.kt].every(Number.isFinite)
      || row.ft < 0 || row.ft > FLIGHT_LIMITS.altitudeFt
      || row.dir < 0 || row.dir > 360
      || row.kt < 0 || row.kt > FLIGHT_LIMITS.windSpeedKt
      || altitudes.has(row.ft)) return null;
    altitudes.add(row.ft);
    result.push({ ft: row.ft, dir: row.dir === 360 ? 0 : row.dir, kt: row.kt });
  }
  return result.sort((a, b) => a.ft - b.ft);
}

export function decodeWind(text) {
  if (typeof text !== 'string' || !text || text.length > FLIGHT_LIMITS.queryLength) return null;
  const parts = text.split(';');
  if (parts.length > FLIGHT_LIMITS.windRows) return null;
  const rows = [];
  for (const part of parts) {
    const fields = part.split(',');
    if (fields.length !== 3) return null;
    const [ft, dir, kt] = fields.map(decimal);
    rows.push({ ft, dir, kt });
  }
  return validateWind(rows);
}

export function validStartTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function parseFlightSettings(search = '') {
  const result = { area: null, wind: null, startTime: DEFAULT_START_TIME, errors: [] };
  if (typeof search !== 'string' || search.length > FLIGHT_LIMITS.queryLength) {
    result.errors.push('共有URLが長すぎるため、初期設定を使います。');
    return result;
  }
  const params = new URLSearchParams(search);
  for (const [key, target, decode, label] of [
    ['a', 'area', decodeArea, 'エリア'],
    ['w', 'wind', decodeWind, '風'],
    ['time', 'startTime', value => validStartTime(value) ? value : null, '開始時刻'],
  ]) {
    if (!params.has(key)) continue;
    const values = params.getAll(key);
    const value = values.length === 1 ? decode(values[0]) : null;
    if (value === null) result.errors.push(`${label}の指定が不正なため、初期設定を使います。`);
    else result[target] = value;
  }
  // No development flags are returned. Unknown parameters never become settings.
  return result;
}

// Return a query string without '?'. Construct an allowlisted set of parameters
// instead of copying the current URL and its development or unknown flags.
export function buildShareQuery({ area = null, wind = null, startTime = DEFAULT_START_TIME, mode } = {}) {
  const params = new URLSearchParams();
  if (area !== null) {
    if (!validArea(area)) throw new TypeError('Invalid flight area');
    params.set('a', `${area.lon.toFixed(4)},${area.lat.toFixed(4)}`);
  }
  if (wind !== null) {
    const rows = validateWind(wind);
    if (!rows) throw new TypeError('Invalid flight wind');
    params.set('w', rows.map(row => `${row.ft},${row.dir},${row.kt}`).join(';'));
  }
  if (!validStartTime(startTime)) throw new TypeError('Invalid flight start time');
  params.set('time', startTime);
  if (mode !== undefined && mode !== null) {
    if (mode !== 'chase') throw new TypeError('Invalid flight mode');
    params.set('mode', mode);
  }
  const query = params.toString();
  if (query.length + 1 > FLIGHT_LIMITS.queryLength) throw new RangeError('Flight URL is too long');
  return query;
}
