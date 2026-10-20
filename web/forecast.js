// Prices heating settings for the "what if" planner, the same way the
// controller's budget forecast does (server/energy/planner.js forecast in
// the heating repository), from the kit the controller uploads
// (server/energy/whatif.js). Pure functions, no network.
//
// Each quarter hour, every enabled zone in a warm period heats for a share
// of the time that grows with the gap between its target and the outside
// temperature (raised by the sun in zones it reaches); hot water heats for
// its whole period. Gas per hour of heating, the daily base and the tariff
// turn that into money.

const STEP_SECONDS = 15 * 60;
const MAX_LIFT = 30; // as learning/model.js solAir

const minutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};

function solAir(tOut, sunKw, thermal) {
  if (!thermal || !thermal.sun || !sunKw || !thermal.k) return tOut;
  return tOut + Math.min(MAX_LIFT, (thermal.sun * sunKw) / thermal.k);
}

// The settings as the controller has them now: { local_id: { enabled, slots } }
export function currentSettings(kit) {
  const out = {};
  kit.zones.forEach((z) => (out[z.local_id] = { enabled: z.enabled, slots: z.slots.map((s) => ({ ...s })) }));
  return out;
}

// Adds one quarter hour to the running totals
function step(kit, settings, totals, day, dow, minute, outside, sunFor) {
  const d = (totals.days[day] ||= { kwh: kit.base_kwh_day });
  kit.zones.forEach((z) => {
    const s = settings[z.local_id];
    if (!s || !s.enabled) return;
    const slot = s.slots.find((x) => x.day == dow && minute >= minutes(x.from) && minute < minutes(x.to));
    if (!slot) return;
    let h;
    if (!z.has_sensors) h = 0.25; // hot water: heats for the whole period
    else {
      const sun = z.thermal ? sunFor(z.thermal.facing) : 0;
      h = 0.25 * Math.min(1, z.hours_per_degree_hour * Math.max(0, Number(slot.temp) - solAir(outside, sun, z.thermal)));
      if (z.eco) h *= 1 - kit.eco_saving;
    }
    const kwh = h * z.kwh_per_hour;
    d.kwh += kwh;
    totals.zones[z.local_id] = (totals.zones[z.local_id] || 0) + kwh * kit.tariff.unit_rate;
    totals.hours[z.local_id] = (totals.hours[z.local_id] || 0) + h;
  });
}

function finish(kit, totals, spent) {
  const days = Object.keys(totals.days).length;
  const energy = Object.values(totals.days).reduce((s, d) => s + d.kwh * kit.tariff.unit_rate, 0);
  return {
    total_pence: spent + energy + days * kit.tariff.standing,
    spent_pence: spent,
    standing_pence: days * kit.tariff.standing,
    other_pence: days * kit.base_kwh_day * kit.tariff.unit_rate,
    zones: totals.zones,
    hours: totals.hours,
    days,
  };
}

// The rest of this billing month, with its weather forecast, plus what's
// been spent so far
export function priceCurrent(kit, settings) {
  const totals = { days: {}, zones: {}, hours: {} };
  const st = kit.steps;
  let offsetAt = 0;
  for (let i = 0; i < st.outdoor.length; i++) {
    while (offsetAt + 1 < st.offsets.length && st.offsets[offsetAt + 1][0] <= i) offsetAt++;
    // the controller's local time for this step
    const local = new Date((st.from + i * STEP_SECONDS + st.offsets[offsetAt][1] * 60) * 1000);
    const day = local.toISOString().slice(0, 10);
    step(kit, settings, totals, day, local.getUTCDay(), local.getUTCHours() * 60 + local.getUTCMinutes(), st.outdoor[i],
      (facing) => (st.sun[facing] ? st.sun[facing][i] || 0 : 0));
  }
  return finish(kit, totals, kit.spent_pence);
}

// A whole calendar month (0-11) in typical weather for this home
export function priceTypicalMonth(kit, settings, month, year) {
  const totals = { days: {}, zones: {}, hours: {} };
  const days = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const dow = new Date(year, month, d).getDay();
    const key = `${year}-${month}-${d}`;
    for (let q = 0; q < 96; q++) {
      const hour = Math.floor(q / 4);
      step(kit, settings, totals, key, dow, q * 15, kit.typical.outdoor[month][hour],
        (facing) => (kit.typical.sun[facing] ? kit.typical.sun[facing][month][hour] : 0));
    }
  }
  return finish(kit, totals, 0);
}
