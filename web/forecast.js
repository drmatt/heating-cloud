// Prices heating settings for the "what if" planner, the same way the
// controller's budget forecast does, from the kit the controller uploads
// (server/energy/whatif.js in the heating repository). Pure functions, no
// network.
//
// Zones with intelligent heating are priced by running their controller
// ahead a quarter hour at a time: the look-ahead control
// (server/control/eco.js) with the zone's learned heater and room model
// (server/learning/dynamics.js), so preheating a slow underfloor floor
// before its warm time is counted. Other zones heat for a share of each
// quarter hour in their periods that grows with the gap between target and
// outside temperature (server/energy/planner.js forecast); hot water heats
// for its whole period. Gas per hour of heating, the daily base and the
// tariff turn that into money.
//
// The controller code is ported here, not shared, so tests/what-if.test.mjs
// checks this gives the controller's answer for the same kit.

const STEP_SECONDS = 15 * 60;
const MAX_LIFT = 30; // learning/model.js solAir

// learning/dynamics.js
const SIM_STEP = 5 * 60;
const HOUR = 3600;
const DAY_FROM = 7; // free heat: Gday from 07:00 to 23:00, Gnight otherwise
const DAY_TO = 23;

// control/eco.js
const FROST_TEMP = 5;
const MIN_ON_MINUTES = 10;
const MIN_OFF_MINUTES = 10;
const DEFAULT_OUTDOOR = 8;
const MAX_PREHEAT_HOURS = 6;
const PAUSE_MINUTES = 90;

const minutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};

function solAir(tOut, sunKw, thermal) {
  if (!thermal || !thermal.sun || !sunKw || !thermal.k) return tOut;
  return tOut + Math.min(MAX_LIFT, (thermal.sun * sunKw) / thermal.k);
}

// ---------------------------------------------------------------------------
// The heater and room model (learning/dynamics.js)

function chargeStep(x, on, hours, d) {
  if (on) return 1 + (x - 1) * Math.exp(-hours / (d.tauUp || d.tau));
  return x * Math.exp(-hours / d.tau);
}

function freeHeat(d, t) {
  if (d.Gday == null && d.Gnight == null) return d.G || 0;
  const hour = d.hourOf(t);
  return (hour >= DAY_FROM && hour < DAY_TO ? d.Gday : d.Gnight) || 0;
}

function simulate(d, state, t0, mins, on, outdoor, sun, visit) {
  let T = state.T;
  let X = state.X;
  const h = SIM_STEP / HOUR;
  for (let t = t0; t < t0 + mins * 60; t += SIM_STEP) {
    const u = on(t);
    const out = outdoor(t);
    const S = sun ? sun(t) || 0 : 0;
    const Xn = chargeStep(X, u, h, d);
    const Xmean = (X + Xn) / 2;
    T += (d.H * Xmean - d.k * (T - out) + (d.sun || 0) * S + freeHeat(d, t)) * h;
    X = Xn;
    if (visit && visit(t + SIM_STEP, T, X) === false) break;
  }
  return { T, X };
}

// ---------------------------------------------------------------------------
// Look-ahead control (control/eco.js), for a reading that's always fresh

function required(s, t) {
  let floor = -Infinity;
  const bias = s.startBias || 0;
  for (const p of s.periods) {
    if (p.from - s.now > MAX_PREHEAT_HOURS * 3600) continue;
    if (t >= p.from && t < p.to) floor = Math.max(floor, p.target - s.margin + (p.from > s.now ? bias : Math.max(0, bias)));
  }
  return floor;
}

function outdoorFn(s) {
  const fixed = s.outdoor == null ? DEFAULT_OUTDOOR : s.outdoor;
  return s.outdoorAt ? (t) => { const v = s.outdoorAt(t); return v == null ? fixed : v; } : () => fixed;
}

function meets(s, T, delay) {
  let ok = true;
  const start = s.now + delay * 60;
  simulate(s.dynamics, { T, X: s.X }, s.now, MAX_PREHEAT_HOURS * 60, (t) => t >= start, outdoorFn(s), s.sunAt, (t, temp) => {
    if (temp < required(s, t) - 0.05) ok = false;
    return ok;
  });
  return ok;
}

function latestStart(s, T) {
  if (!meets(s, T, 0)) return 0;
  let lo = 0;
  let hi = MAX_PREHEAT_HOURS * 60;
  if (meets(s, T, hi)) return null;
  while (hi - lo > 5) {
    const mid = (lo + hi) / 2;
    if (meets(s, T, mid)) lo = mid;
    else hi = mid;
  }
  return Math.round(lo);
}

function coastFrom(s, T, period) {
  let peak = T;
  let warm = true;
  const hours = Math.min(12, Math.max(2 * s.dynamics.tau + 1, period ? (period.to - s.now) / 3600 : 0));
  const floor = period ? period.target - s.margin : -Infinity;
  simulate(s.dynamics, { T, X: s.X }, s.now, hours * 60, () => false, outdoorFn(s), s.sunAt, (t, temp) => {
    peak = Math.max(peak, temp);
    if (period && t < period.to && temp < floor) warm = false;
  });
  return { peak, warm };
}

function lookAhead(s) {
  const T = s.temp;
  const current = s.periods.find((p) => s.now >= p.from && s.now < p.to) || null;
  const wait = latestStart(s, T);
  if (s.isOn) {
    if (!current) return wait == null || wait >= PAUSE_MINUTES ? false : true;
    const coast = coastFrom(s, T, current);
    if (coast.warm) return false;
    if (coast.peak >= current.target && wait != null && wait >= MIN_OFF_MINUTES) return false;
    return true;
  }
  if (wait != null && wait >= MIN_OFF_MINUTES) return false;
  if (wait == null) return false;
  return true;
}

function decide(s) {
  if (s.temp < FROST_TEMP) return true;
  let on = lookAhead(s);
  if (s.isOn && !on && s.minutesInState < MIN_ON_MINUTES) on = true;
  else if (!s.isOn && on && s.minutesInState < MIN_OFF_MINUTES) on = false;
  return on;
}

// ---------------------------------------------------------------------------
// Running an intelligent zone ahead (energy/zonesim.js)

function localAt(steps, i, cursor) {
  while (cursor.k + 1 < steps.offsets.length && steps.offsets[cursor.k + 1][0] <= i) cursor.k++;
  const d = new Date((steps.from + i * STEP_SECONDS + steps.offsets[cursor.k][1] * 60) * 1000);
  return { day: d.toISOString().slice(0, 10), dow: d.getUTCDay(), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function periodsOver(steps, slots) {
  const out = [];
  const cursor = { k: 0 };
  let current = null;
  for (let i = 0; i < steps.outdoor.length; i++) {
    const l = localAt(steps, i, cursor);
    const slot = slots.find((s) => s.day == l.dow && l.minute >= minutes(s.from) && l.minute < minutes(s.to));
    const t = steps.from + i * STEP_SECONDS;
    const target = slot ? Number(slot.temp) : null;
    if (current && (target == null || target != current.target)) {
      current.to = t;
      out.push(current);
      current = null;
    }
    if (target != null && !current) current = { from: t, target };
  }
  if (current) {
    current.to = steps.from + steps.outdoor.length * STEP_SECONDS;
    out.push(current);
  }
  return out;
}

function hourAt(steps, t) {
  const i = Math.floor((t - steps.from) / STEP_SECONDS);
  let offset = steps.offsets[0][1];
  for (let k = 1; k < steps.offsets.length && steps.offsets[k][0] <= i; k++) offset = steps.offsets[k][1];
  return new Date((t + offset * 60) * 1000).getUTCHours();
}

// Hours of heating by local day for one intelligent zone
function simulateZone(zone, slots, steps, sun) {
  // free heat follows the controller's clock, as the steps record it
  const d = { ...zone.dynamics, hourOf: (t) => hourAt(steps, t) };
  const n = steps.outdoor.length;
  const at = (t) => Math.min(n - 1, Math.max(0, Math.round((t - steps.from) / STEP_SECONDS)));
  const outdoorAt = (t) => steps.outdoor[at(t)];
  const sunAt = sun ? (t) => sun[at(t)] : null;
  const all = periodsOver(steps, slots);

  let T = zone.start.T;
  let X = zone.start.X;
  let on = !!zone.start.on;
  let since = 0;
  let p0 = 0;
  const cursor = { k: 0 };
  const hoursByDay = {};

  for (let i = 0; i < n; i++) {
    const t = steps.from + i * STEP_SECONDS;
    while (p0 < all.length && all[p0].to <= t) p0++;
    const upcoming = [];
    for (let j = p0; j < all.length && all[j].from < t + 30 * 3600; j++) upcoming.push(all[j]);
    const result = decide({
      temp: T, isOn: on, minutesInState: since, outdoor: steps.outdoor[i], margin: zone.margin, now: t,
      dynamics: d, X, periods: upcoming, outdoorAt, sunAt, startBias: zone.startBias || 0,
    });
    if (result != on) since = 0;
    on = result;
    since += 15;
    const next = simulate(d, { T, X }, t, 15, () => on, outdoorAt, sunAt);
    T = next.T;
    X = next.X;
    const day = localAt(steps, i, cursor).day;
    hoursByDay[day] = (hoursByDay[day] || 0) + (on ? 0.25 : 0);
  }
  return hoursByDay;
}

// ---------------------------------------------------------------------------
// Pricing

// The settings as the controller has them now: { local_id: { enabled, slots } }
export function currentSettings(kit) {
  const out = {};
  kit.zones.forEach((z) => (out[z.local_id] = { enabled: z.enabled, slots: z.slots.map((s) => ({ ...s })) }));
  return out;
}

// steps: { from, outdoor[], sun{facing: []}, offsets }; skip: local days to
// leave out of the total (a warm-up day); start(z): where a simulated zone
// starts
function priceSteps(kit, settings, steps, spent, skip, start) {
  const days = {};
  const zones = {};
  const hours = {};
  const add = (day, z, h) => {
    if (!h) return;
    const kwh = h * z.kwh_per_hour;
    days[day].kwh += kwh;
    zones[z.local_id] = (zones[z.local_id] || 0) + kwh * kit.tariff.unit_rate;
    hours[z.local_id] = (hours[z.local_id] || 0) + h;
  };

  // every day the steps touch, and the degree-hours zones quarter by quarter
  const cursor = { k: 0 };
  for (let i = 0; i < steps.outdoor.length; i++) {
    const l = localAt(steps, i, cursor);
    days[l.day] ||= { kwh: kit.base_kwh_day };
    kit.zones.forEach((z) => {
      const s = settings[z.local_id];
      if (!s || !s.enabled || z.sim) return;
      const slot = s.slots.find((x) => x.day == l.dow && l.minute >= minutes(x.from) && l.minute < minutes(x.to));
      if (!slot) return;
      let h;
      if (!z.has_sensors) h = 0.25; // hot water: heats for the whole period
      else {
        const sun = z.thermal && steps.sun[z.thermal.facing] ? steps.sun[z.thermal.facing][i] || 0 : 0;
        h = 0.25 * Math.min(1, z.hours_per_degree_hour * Math.max(0, Number(slot.temp) - solAir(steps.outdoor[i], sun, z.thermal)));
        if (z.eco) h *= 1 - kit.eco_saving;
      }
      add(l.day, z, h);
    });
  }

  // intelligent zones, by running their controller
  kit.zones.forEach((z) => {
    const s = settings[z.local_id];
    if (!s || !s.enabled || !z.sim) return;
    const sim = { ...z.sim, start: start(z) };
    const byDay = simulateZone(sim, s.slots, steps, z.sim.facing != null ? steps.sun[z.sim.facing] || null : null);
    Object.keys(days).forEach((day) => add(day, z, byDay[day] || 0));
  });

  skip.forEach((day) => delete days[day]);
  const count = Object.keys(days).length;
  const energy = Object.values(days).reduce((sum, d) => sum + d.kwh * kit.tariff.unit_rate, 0);
  return {
    total_pence: spent + energy + count * kit.tariff.standing,
    spent_pence: spent,
    standing_pence: count * kit.tariff.standing,
    other_pence: count * kit.base_kwh_day * kit.tariff.unit_rate,
    zones,
    hours,
    days: count,
  };
}

// The rest of this billing month, with its weather forecast, plus what's
// been spent so far
export function priceCurrent(kit, settings) {
  return priceSteps(kit, settings, kit.steps, kit.spent_pence, [], (z) => z.sim.start);
}

// A whole calendar month (0-11) in typical weather for this home, in this
// browser's local time. Intelligent zones start a day early, near their
// comfort floor, so the month doesn't begin from a cold house.
export function priceTypicalMonth(kit, settings, month, year) {
  const first = new Date(year, month, 1);
  const warmUp = new Date(year, month, 0); // the day before
  const end = new Date(year, month + 1, 1);
  const steps = { from: Math.floor(warmUp.getTime() / 1000), outdoor: [], sun: {}, offsets: [] };
  const facings = Object.keys(kit.typical.sun);
  facings.forEach((f) => (steps.sun[f] = []));
  let last = null;
  for (let t = steps.from, i = 0; t < end.getTime() / 1000; t += STEP_SECONDS, i++) {
    const local = new Date(t * 1000);
    // the warm-up day uses the month's own typical weather
    const m = local < first ? month : local.getMonth();
    const hour = local.getHours();
    steps.outdoor.push(kit.typical.outdoor[m][hour]);
    facings.forEach((f) => steps.sun[f].push(kit.typical.sun[f][m][hour]));
    const offset = -local.getTimezoneOffset();
    if (offset !== last) {
      steps.offsets.push([i, offset]);
      last = offset;
    }
  }
  const warmKey = new Date(steps.from * 1000 + steps.offsets[0][1] * 60000).toISOString().slice(0, 10);
  return priceSteps(kit, settings, steps, 0, [warmKey], (z) => {
    const temps = (settings[z.local_id]?.slots || []).map((s) => Number(s.temp));
    return { T: (temps.length ? Math.max(...temps) : 18) - z.sim.margin, X: 0, on: false };
  });
}
