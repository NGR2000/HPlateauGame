import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLIGHT_LIMITS, decodeArea, decodeWind, validateWind,
  validStartTime, parseFlightSettings, buildShareQuery,
} from '../game/prototype/flightSettings.js';

test('shared flight settings round trip with canonical wind and encoded delimiters', () => {
  const source = {
    area: { lon: 130.25, lat: 33.27 },
    wind: [{ ft: 500, dir: 360, kt: 5.5 }, { ft: 0, dir: 140, kt: 3 }],
    startTime: '16:45',
  };
  const query = buildShareQuery(source);
  assert.ok(query.includes('%3B'));
  assert.deepEqual(parseFlightSettings(`?${query}`), {
    area: source.area,
    wind: [{ ft: 0, dir: 140, kt: 3 }, { ft: 500, dir: 0, kt: 5.5 }],
    startTime: '16:45', errors: [],
  });
  assert.equal(source.wind[0].dir, 360, 'input rows must not be mutated');
});

test('wind boundaries are finite, bounded and require distinct altitudes', () => {
  assert.deepEqual(decodeWind('30000,360,150;0,0,0'), [
    { ft: 0, dir: 0, kt: 0 }, { ft: 30000, dir: 0, kt: 150 },
  ]);
  for (const value of ['30001,180,5', '-1,180,5', '0,-1,5', '0,361,5', '0,180,-1',
    '0,180,151', '0,1e308,5', '0,180,1e309', '0,Infinity,5', '0,NaN,5',
    '0,0,1;0,90,2', '0,0,1;0.0,90,2']) {
    assert.equal(decodeWind(value), null, value);
  }
  assert.equal(validateWind([{ ft: '0', dir: 180, kt: 3 }]), null);
  assert.equal(validateWind([{ ft: NaN, dir: 180, kt: 3 }]), null);
  assert.equal(validateWind([null]), null);
});

test('malformed wind rejects the whole shared table instead of salvaging rows', () => {
  for (const value of ['', '0,180,5;', ';0,180,5', '0,180,5;bad', ',180,5',
    '0,,5', '0,180,', '0,180,5,6', '0, 180,5', '0,0x10,5', '0,true,5',
    '0,<img src=x onerror=alert(1)>,5']) {
    assert.equal(decodeWind(value), null, value);
  }
  assert.equal(decodeWind(Array.from({ length: 32 }, (_, i) => `${i},180,5`).join(';')).length, 32);
  assert.equal(decodeWind(Array.from({ length: 33 }, (_, i) => `${i},180,5`).join(';')), null);
  assert.equal(decodeWind('0,180,' + '0'.repeat(4096)), null);
});

test('area coordinates are strict and remain within the documented region', () => {
  assert.deepEqual(decodeArea('122,24'), { lon: 122, lat: 24 });
  assert.deepEqual(decodeArea('148,46'), { lon: 148, lat: 46 });
  for (const value of ['121.999,33', '149,33', '130,23.999', '130,46.001',
    '130,Infinity', '130,', ',33', '130,33,0', '130, 33', '0x82,33',
    '130,33" onmouseover="alert(1)']) assert.equal(decodeArea(value), null, value);
});

test('start time accepts only HH:MM in a day and invalid input falls back visibly', () => {
  for (const time of ['00:00', '07:00', '16:59', '23:59']) assert.equal(validStartTime(time), true);
  for (const time of ['24:00', '07:60', '7:00', '07:00:00', ' 07:00', '', null]) {
    assert.equal(validStartTime(time), false);
  }
  const result = parseFlightSettings('?a=0,0&w=0,180,151&time=24:00');
  assert.equal(result.area, null);
  assert.equal(result.wind, null);
  assert.equal(result.startTime, '07:00');
  assert.equal(result.errors.length, 3);
});

test('oversized and ambiguous queries cannot override defaults', () => {
  const oversized = parseFlightSettings(`?time=16:00&padding=${'x'.repeat(FLIGHT_LIMITS.queryLength)}`);
  assert.equal(oversized.startTime, '07:00');
  assert.equal(oversized.errors.length, 1);
  const duplicate = parseFlightSettings('?a=130,33&a=140,36&w=0,180,5&w=500,90,5&time=07:00&time=16:00');
  assert.equal(duplicate.area, null);
  assert.equal(duplicate.wind, null);
  assert.equal(duplicate.startTime, '07:00');
  assert.equal(duplicate.errors.length, 3);
  assert.equal(parseFlightSettings({}).errors.length, 1);
});

test('development and unknown flags never survive settings parsing or link construction', () => {
  const result = parseFlightSettings('?dev=1&city=2&road=1&__proto__=bad&time=08:30');
  assert.deepEqual(result, { area: null, wind: null, startTime: '08:30', errors: [] });
  const query = buildShareQuery({ ...result, dev: 1, city: 2, road: 1 });
  assert.equal(query, 'time=08%3A30');
  assert.throws(() => buildShareQuery({ mode: 'chase&dev=1' }), /Invalid flight mode/);
  assert.throws(() => buildShareQuery({ wind: [{ ft: 0, dir: 180, kt: 999 }] }), /Invalid flight wind/);
  assert.throws(() => buildShareQuery({ area: { lon: '130', lat: 33 } }), /Invalid flight area/);
  assert.throws(() => buildShareQuery({ startTime: '24:00' }), /Invalid flight start time/);
});
