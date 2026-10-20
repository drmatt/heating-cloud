// The dashboard's what-if pricing must match the controller's budget
// forecast. The fixture is a kit made by the controller's code
// (server/energy/whatif.js) from made-up inputs, over a billing month that
// includes the October clock change; it carries the controller's answer.
//   node tests/what-if.test.mjs
import { readFileSync } from "node:fs";
import { priceCurrent, priceTypicalMonth, currentSettings } from "../web/forecast.js";

const kit = JSON.parse(readFileSync(new URL("./fixtures/what-if-kit.json", import.meta.url)));
const ok = (c, msg) => { console.log((c ? "PASS " : "FAIL ") + msg); if (!c) process.exitCode = 1; };

const now = priceCurrent(kit, currentSettings(kit));
ok(Math.abs(now.total_pence - kit.expected_pence) <= 1, `matches the controller: ${now.total_pence.toFixed(1)}p vs ${kit.expected_pence}p`);

// warmer always costs more; an earlier start needn't for an underfloor room
// that would otherwise preheat into the midday sun and overshoot
const warmer = currentSettings(kit);
warmer[1].slots = warmer[1].slots.map((s) => ({ ...s, temp: s.temp + 1 }));
ok(priceCurrent(kit, warmer).zones[1] > now.zones[1], "a warmer Kitchen costs more");
const longer = currentSettings(kit);
longer[2].slots = longer[2].slots.map((s) => (s.from == "06:30" ? { ...s, to: "12:00" } : s));
ok(priceCurrent(kit, longer).zones[2] > now.zones[2], "keeping the first floor warm for longer costs more");

const off = currentSettings(kit);
off[2].enabled = false;
ok(!priceCurrent(kit, off).zones[2] && priceCurrent(kit, off).total_pence < now.total_pence, "switching a zone off saves its cost");

const jan = priceTypicalMonth(kit, currentSettings(kit), 0, 2027);
const jul = priceTypicalMonth(kit, currentSettings(kit), 6, 2027);
ok(jan.days == 31 && jan.total_pence > jul.total_pence, `a typical January costs more than July (${Math.round(jan.total_pence)}p vs ${Math.round(jul.total_pence)}p)`);
ok(jan.spent_pence == 0 && Math.abs(jan.standing_pence - 31 * kit.tariff.standing) < 1e-6, "a typical month has no spend so far and 31 standing charges");
