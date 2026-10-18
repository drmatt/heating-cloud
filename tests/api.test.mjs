const URL_ = "http://127.0.0.1:54321";
const ANON = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
async function call(method, path, body, tok, prefer) {
  const h = { apikey: ANON, "Content-Type": "application/json" };
  if (tok) h.Authorization = "Bearer " + tok;
  if (prefer) h.Prefer = prefer;
  const r = await fetch(URL_ + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: r.status, body: j };
}
const ok = (c, msg) => console.log((c ? "PASS " : "FAIL ") + msg);
for (let i = 0; i < 30; i++) { const r = await fetch(URL_ + "/functions/v1/register-controller", { method: "GET", headers: { apikey: ANON } }).catch(() => null); if (r && r.status == 405) break; await new Promise(r => setTimeout(r, 1000)); }

// controller registers
const pw = "a".repeat(10) + crypto.randomUUID().replace(/-/g, "");
let r = await call("POST", "/functions/v1/register-controller", { password: pw, software_version: "test" });
ok(r.status == 200 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(r.body.claim_code), "register controller " + JSON.stringify(r.body).slice(0, 120));
const ctrl = r.body;
r = await call("POST", "/auth/v1/token?grant_type=password", { email: ctrl.email, password: pw });
const ctok = r.body.access_token; ok(!!ctok, "controller signs in");
r = await call("POST", "/rest/v1/rpc/controller_sync", { p_report: { software_version: "t" } }, ctok);
ok(r.body.claimed === false && r.body.claim_code == ctrl.claim_code, "unclaimed sync returns code");

// customers sign up
async function signup(email) { const s = await call("POST", "/auth/v1/signup", { email, password: "correct-horse-9" }); return s.body.access_token; }
const alice = await signup("alice" + Date.now() + "@example.com"), bob = await signup("bob" + Date.now() + "@example.com");
ok(alice && bob, "customers sign up");

r = await call("POST", "/rest/v1/rpc/claim_controller", { p_code: "ZZZZ-ZZZZ" }, bob);
ok(r.status >= 400, "wrong code rejected: " + JSON.stringify(r.body.message));
r = await call("POST", "/rest/v1/rpc/claim_controller", { p_code: ctrl.claim_code.toLowerCase().replace("-", " "), p_home_name: "Alice's house" }, alice);
ok(r.status == 200, "alice claims with sloppy code formatting");
const home = r.body;
r = await call("POST", "/rest/v1/rpc/claim_controller", { p_code: ctrl.claim_code }, bob);
ok(r.status >= 400, "code can't be reused");
r = await call("POST", "/rest/v1/rpc/claim_controller", { p_code: ctrl.claim_code }, ctok);
ok(r.status >= 400, "controller can't claim");

// first sync imports
const report = { software_version: "t",
  zones: [{ local_id: 1, name: "Kitchen ", is_enabled: true, is_on: false, desired_temp: 21, current_temp: 19.5 }, { local_id: 5, name: "Hot water", is_enabled: true, is_on: true, desired_temp: 5, current_temp: null }],
  schedule: [{ zone_local_id: 1, day: 1, on_time: "07:00:00", off_time: "09:00:00", temp: 21 }, { zone_local_id: 1, day: 1, on_time: "10:00:00", off_time: "09:00:00", temp: 21 }],
  sensors: [{ device_id: "887B0AA4AE30", name: "Kitchen", zone_local_id: 1 }],
  sensor_states: [{ device_id: "887B0AA4AE30", last_temp: 19.5, last_battery: 4095, last_seen_at: new Date().toISOString() }] };
r = await call("POST", "/rest/v1/rpc/controller_sync", { p_report: report }, ctok);
ok(r.body.claimed && r.body.imported && r.body.zones.length == 2 && r.body.schedule.length == 1 && r.body.sensors.length == 1, "first sync imports (bad slot skipped): " + JSON.stringify(r.body).slice(0, 200));
r = await call("POST", "/rest/v1/rpc/controller_sync", { p_report: report }, ctok);
ok(r.body.imported === false, "second sync doesn't re-import");

// readings
r = await call("POST", "/rest/v1/readings?on_conflict=home_id,device_id,time", [{ home_id: home, device_id: "887B0AA4AE30", time: new Date().toISOString(), temp: 19.5, battery: 4095 }], ctok, "resolution=ignore-duplicates,return=minimal");
ok(r.status == 201, "controller uploads readings " + r.status);
r = await call("POST", "/rest/v1/readings", [{ home_id: home, device_id: "X", time: new Date().toISOString(), temp: 1 }], alice);
ok(r.status >= 400, "customer can't insert readings");

// isolation
r = await call("GET", "/rest/v1/zones?select=name,current_temp", undefined, alice);
ok(r.body.length == 2, "alice sees her zones " + JSON.stringify(r.body));
for (const t of ["zones", "readings", "sensors", "homes", "controllers", "schedule_slots", "commands", "home_members"]) {
  r = await call("GET", "/rest/v1/" + t + "?select=*", undefined, bob);
  ok(Array.isArray(r.body) && r.body.length == 0, "bob sees no " + t);
}
r = await call("GET", "/rest/v1/zones?select=*", undefined, null);
ok(r.status >= 400 || r.body.length == 0, "anonymous sees nothing");

// customer edits
const zones = (await call("GET", "/rest/v1/zones?select=id,local_id,name&order=local_id", undefined, alice)).body;
r = await call("PATCH", "/rest/v1/zones?id=eq." + zones[0].id, { boost_until: new Date(Date.now() + 3600e3).toISOString(), name: "Kitchen zone" }, alice, "return=minimal");
ok(r.status == 204, "alice boosts and renames zone");
r = await call("PATCH", "/rest/v1/zones?id=eq." + zones[0].id, { local_id: 9 }, alice);
ok(r.status >= 400, "alice can't change local_id (relay mapping)");
r = await call("PATCH", "/rest/v1/zones?id=eq." + zones[0].id, { name: "hacked" }, bob, "return=representation");
ok(Array.isArray(r.body) && r.body.length == 0, "bob can't rename alice's zone");
r = await call("POST", "/rest/v1/rpc/set_zone_schedule", { p_zone: zones[0].id, p_slots: [{ day: 0, on_time: "06:30", off_time: "08:00", temp: 20 }, { day: 6, on_time: "17:00", off_time: "22:00", temp: 21.5 }] }, alice);
ok(r.status == 204 || r.status == 200, "alice sets schedule " + r.status);
r = await call("POST", "/rest/v1/rpc/set_zone_schedule", { p_zone: zones[0].id, p_slots: [] }, bob);
ok(r.status >= 400, "bob can't set alice's schedule");
r = await call("POST", "/rest/v1/rpc/save_sensor", { p_home: home, p_device: "74DDBAC40A24", p_name: "Landing", p_zone: zones[1].id }, alice);
ok(r.status < 300, "alice names an unassigned sensor");
r = await call("POST", "/rest/v1/rpc/controller_sync", { p_report: report }, ctok);
ok(r.body.zones[0].name == "Kitchen zone" && r.body.zones[0].boost_until && r.body.schedule.length == 2 && r.body.sensors.length == 2, "controller sees changes: " + JSON.stringify(r.body.schedule));

// commands
r = await call("POST", "/rest/v1/commands", { home_id: home, type: "set_sensor_network", payload: { ssid: "Net", pass: "secret" } }, alice, "return=representation");
ok(r.status == 201, "alice queues command");
const cmd = r.body[0];
r = await call("POST", "/rest/v1/commands", { home_id: home, type: "scan_sensors", status: "done" }, alice);
ok(r.status >= 400, "alice can't set command status");
r = await call("POST", "/rest/v1/commands", { home_id: home, type: "scan_sensors" }, bob);
ok(r.status >= 400, "bob can't queue command for alice's home");
r = await call("PATCH", "/rest/v1/commands?id=eq." + cmd.id, { status: "done", payload: { ssid: "Net" }, result: { ok: true } }, ctok, "return=minimal");
ok(r.status == 204, "controller completes command");
r = await call("GET", "/rest/v1/commands?id=eq." + cmd.id + "&select=status,payload", undefined, alice);
ok(r.body[0].status == "done" && !r.body[0].payload.pass, "password scrubbed, status done");
r = await call("POST", "/rest/v1/rpc/controller_add_sensor", { p_device: "AAAA", p_name: "Study", p_zone_local_id: 5 }, ctok);
ok(r.status < 300, "controller adds paired sensor");

// ---------------------------------------------------------------------------
// Energy saving

r = await call("PATCH", "/rest/v1/zones?id=eq." + zones[0].id, { eco_enabled: true, comfort_margin: 1.5 }, alice, "return=minimal");
ok(r.status == 204, "alice changes eco settings");
r = await call("PATCH", "/rest/v1/zones?id=eq." + zones[0].id, { model: { ready: true } }, alice);
ok(r.status >= 400, "alice can't write the learned model");
r = await call("PATCH", "/rest/v1/zones?id=eq." + zones[0].id, { comfort_margin: 5 }, alice);
ok(r.status >= 400, "comfort margin is limited to 0-2");
r = await call("PATCH", "/rest/v1/homes?id=eq." + home, { latitude: 53.41, longitude: -2.15 }, alice, "return=minimal");
ok(r.status == 204, "alice sets the location");

const report2 = Object.assign({}, report, { models: [{ local_id: 1, model: { ready: true, k: 0.05, h: 0.7, overshoot: 0.5 } }] });
r = await call("POST", "/rest/v1/rpc/controller_sync", { p_report: report2 }, ctok);
const kz = r.body.zones.find((z) => z.local_id == 1);
ok(r.body.location.latitude == 53.41 && kz.eco_enabled === true && Number(kz.comfort_margin) == 1.5, "controller gets location and eco settings");
r = await call("GET", "/rest/v1/zones?local_id=eq.1&select=model", undefined, alice);
ok(r.body[0].model?.overshoot == 0.5, "alice sees the learned model");

r = await call("POST", "/rest/v1/zone_daily?on_conflict=home_id,zone_local_id,day", [{ home_id: home, zone_local_id: 1, day: "2026-10-01", boiler_minutes: 120, eco_minutes: 10, hdd: 6 }], ctok, "resolution=merge-duplicates,return=minimal");
ok(r.status == 201, "controller uploads daily figures");
r = await call("POST", "/rest/v1/zone_daily?on_conflict=home_id,zone_local_id,day", [{ home_id: home, zone_local_id: 1, day: "2026-10-01", boiler_minutes: 90, eco_minutes: 10, hdd: 6 }], ctok, "resolution=merge-duplicates,return=minimal");
r = await call("GET", "/rest/v1/zone_daily?select=boiler_minutes", undefined, alice);
ok(r.body.length == 1 && r.body[0].boiler_minutes == 90, "daily figures update in place");
r = await call("GET", "/rest/v1/zone_daily?select=*", undefined, bob);
ok(r.body.length == 0, "bob sees no daily figures");
r = await call("POST", "/rest/v1/zone_daily", [{ home_id: home, zone_local_id: 1, day: "2026-10-02", boiler_minutes: 1 }], alice);
ok(r.status >= 400, "alice can't write daily figures");

r = await call("POST", "/rest/v1/rpc/controller_notify", { p_kind: "switch_on", p_title: "Time to switch the heating on?", p_body: "Kitchen is forecast to fall.", p_zone_local_ids: [1] }, ctok);
const noteId = r.body;
ok(r.status == 200 && noteId, "controller adds advice");
r = await call("POST", "/rest/v1/rpc/controller_notify", { p_kind: "switch_on", p_title: "again", p_body: "again", p_zone_local_ids: [1] }, ctok);
ok(r.body === null, "same advice isn't repeated within 7 days");
r = await call("POST", "/rest/v1/rpc/controller_notify", { p_kind: "switch_on", p_title: "x", p_body: "x", p_zone_local_ids: [1] }, alice);
ok(r.status >= 400, "customers can't add advice");
r = await call("GET", "/rest/v1/notifications?select=*", undefined, bob);
ok(r.body.length == 0, "bob sees no notifications");
r = await call("PATCH", "/rest/v1/notifications?id=eq." + noteId, { dismissed_at: new Date().toISOString() }, alice, "return=minimal");
ok(r.status == 204, "alice dismisses advice");
r = await call("PATCH", "/rest/v1/notifications?id=eq." + noteId, { body: "edited" }, alice);
ok(r.status >= 400, "alice can't edit advice text");
r = await call("POST", "/functions/v1/send-notification", { notification_id: noteId }, ctok);
ok(r.status == 200 && r.body.reason == "email not configured", "email is skipped until Resend is set up: " + JSON.stringify(r.body));

// ---------------------------------------------------------------------------
// Budget

r = await call("POST", "/rest/v1/budgets", { home_id: home, monthly_pence: 8000, start_day: 15, boiler_kw: 28 }, alice, "return=minimal");
ok(r.status == 201, "alice sets a budget");
r = await call("POST", "/rest/v1/budgets?on_conflict=home_id", { home_id: home, monthly_pence: 9000, start_day: 15, boiler_kw: 28 }, alice, "resolution=merge-duplicates,return=minimal");
ok(r.status == 201 || r.status == 204 || r.status == 200, "alice changes the budget (upsert): " + r.status + " " + JSON.stringify(r.body));
r = await call("POST", "/rest/v1/budgets", { home_id: home, monthly_pence: 1 }, bob);
ok(r.status >= 400, "bob can't set alice's budget");
r = await call("GET", "/rest/v1/budgets?select=*", undefined, bob);
ok(r.body.length == 0, "bob can't see alice's budget");
r = await call("PATCH", "/rest/v1/zones?id=eq." + zones[0].id, { min_temp: 17 }, alice, "return=minimal");
ok(r.status == 204, "alice sets a zone minimum");
r = await call("PATCH", "/rest/v1/zones?id=eq." + zones[0].id, { budget_offset: 3 }, alice);
ok(r.status >= 400, "alice can't set the budget offset directly");

r = await call("POST", "/rest/v1/rooms", { home_id: home, zone_id: zones[0].id, name: "Kitchen", kind: "kitchen", usage: "often", periods: [{ days: [1, 2, 3, 4, 5], from: "07:00", to: "09:00" }] }, alice, "return=minimal");
ok(r.status == 201, "alice adds a room");
r = await call("POST", "/rest/v1/rooms", { home_id: home, zone_id: zones[0].id, name: "Sneaky" }, bob);
ok(r.status >= 400, "bob can't add rooms to alice's home");

r = await call("POST", "/rest/v1/rpc/controller_sync", { p_report: Object.assign({}, report2, { zones: report.zones.map((z) => Object.assign({}, z, { budget_offset: 1.5 })) }) }, ctok);
ok(r.body.budget?.monthly_pence == 9000 && r.body.budget.start_day == 15 && r.body.rooms.length == 1 && r.body.rooms[0].zone_local_id == 1
  && r.body.zones.find((z) => z.local_id == 1).min_temp == 17, "controller gets the budget, rooms and minimums");
r = await call("GET", "/rest/v1/zones?local_id=eq.1&select=budget_offset", undefined, alice);
ok(Number(r.body[0].budget_offset) == 1.5, "alice sees the budget offset the controller applied");

r = await call("POST", "/rest/v1/energy_daily?on_conflict=home_id,day", [{ home_id: home, day: "2026-10-16", kwh: 40.5, cost_pence: 347, metered: true }], ctok, "resolution=merge-duplicates,return=minimal");
ok(r.status == 201, "controller uploads daily energy");
r = await call("POST", "/rest/v1/energy_daily", [{ home_id: home, day: "2026-10-17", kwh: 1, cost_pence: 1, metered: true }], alice);
ok(r.status >= 400, "alice can't write energy figures");
r = await call("POST", "/rest/v1/energy_status?on_conflict=home_id", [{ home_id: home, supplier: "Octopus Energy", unit_rate_pence: 7.86, standing_pence: 28.85, connected: true }], ctok, "resolution=merge-duplicates,return=minimal");
ok(r.status == 201, "controller reports the supply");
r = await call("POST", "/rest/v1/budget_plans", { home_id: home, period_start: "2026-10-15", period_end: "2026-11-15", budget_pence: 9000, spent_pence: 1000, forecast_pence: 8500, forecast_without_plan_pence: 9800, achievable: true, automatic: [{ text: "Kitchen 1 °C cooler" }] }, ctok, "return=minimal");
ok(r.status == 201, "controller adds a plan");
r = await call("POST", "/rest/v1/budget_plans", { home_id: home, period_start: "2026-10-15", period_end: "2026-11-15", budget_pence: 1, spent_pence: 0, forecast_pence: 0, forecast_without_plan_pence: 0, achievable: true }, alice);
ok(r.status >= 400, "alice can't write plans");
for (const t of ["energy_daily", "energy_status", "budget_plans", "rooms"]) {
  r = await call("GET", "/rest/v1/" + t + "?select=*", undefined, bob);
  ok(Array.isArray(r.body) && r.body.length == 0, "bob sees no " + t);
}
r = await call("GET", "/rest/v1/assistant_usage?select=*", undefined, alice);
ok(r.status >= 400 || r.body.length == 0, "assistant usage isn't readable by customers");

r = await call("POST", "/rest/v1/commands", { home_id: home, type: "set_octopus", payload: { account: "A-1", api_key: "test-value" } }, alice, "return=representation");
ok(r.status == 201, "alice can send Octopus details to her controller");
r = await call("POST", "/rest/v1/rpc/controller_notify", { p_kind: "budget_at_risk", p_title: "t", p_body: "b", p_zone_local_ids: [] }, ctok);
ok(r.status == 200 && r.body, "controller can send budget notices");

r = await call("POST", "/functions/v1/assistant", { mode: "ask", messages: [{ role: "user", content: "hi" }] }, alice);
ok(r.status == 503 && /set up/.test(r.body.error), "assistant says it isn't set up without a key: " + JSON.stringify(r.body));
r = await call("POST", "/functions/v1/assistant", { mode: "ask", messages: [{ role: "user", content: "hi" }] }, null);
ok(r.status == 401, "assistant needs a signed-in user");

// ---------------------------------------------------------------------------
// Too hot / too cold

r = await call("POST", "/rest/v1/rpc/report_comfort", { p_zone: zones[0].id, p_room: null, p_feeling: "cold" }, alice);
ok(r.status == 200 && r.body.bump == 1, "alice reports cold: +1 °C for two hours " + JSON.stringify(r.body));
r = await call("POST", "/rest/v1/rpc/report_comfort", { p_zone: zones[0].id, p_room: null, p_feeling: "cold" }, alice);
r = await call("POST", "/rest/v1/rpc/report_comfort", { p_zone: zones[0].id, p_room: null, p_feeling: "cold" }, alice);
ok(r.body.bump == 2, "repeated cold reports add up to at most 2 °C");
r = await call("POST", "/rest/v1/rpc/report_comfort", { p_zone: zones[0].id, p_room: null, p_feeling: "hot" }, alice);
ok(r.body.bump == 1, "a hot report takes a degree back");
r = await call("POST", "/rest/v1/rpc/report_comfort", { p_zone: zones[0].id, p_room: null, p_feeling: "cold" }, bob);
ok(r.status >= 400, "bob can't report on alice's zones");
r = await call("POST", "/rest/v1/rpc/report_comfort", { p_zone: zones[0].id, p_room: null, p_feeling: "lukewarm" }, alice);
ok(r.status >= 400, "only hot or cold");
r = await call("GET", "/rest/v1/comfort_feedback?select=feeling,room_temp,context", undefined, alice);
ok(r.body.length == 4 && r.body[0].context && "eco" in r.body[0].context, "reports are kept with their conditions");
r = await call("GET", "/rest/v1/comfort_feedback?select=*", undefined, ctok);
ok(r.body.length == 4, "the controller can read the reports");
r = await call("GET", "/rest/v1/comfort_feedback?select=*", undefined, bob);
ok(r.body.length == 0, "bob can't see them");
r = await call("POST", "/rest/v1/comfort_feedback", { home_id: home, zone_id: zones[0].id, feeling: "cold" }, alice);
ok(r.status >= 400, "reports only go through report_comfort");
r = await call("POST", "/rest/v1/rpc/controller_report_comfort", { p_prefs: [{ local_id: 1, preferred: 20.5, reports: 4 }] }, ctok);
ok(r.status < 300, "the controller reports what it learned");
r = await call("GET", "/rest/v1/zones?local_id=eq.1&select=comfort_preferred,comfort_reports,comfort_bump", undefined, alice);
ok(Number(r.body[0].comfort_preferred) == 20.5 && r.body[0].comfort_reports == 4, "alice sees the learned preference");
r = await call("POST", "/rest/v1/rpc/controller_report_comfort", { p_prefs: [] }, alice);
ok(r.status >= 400, "customers can't set learned preferences");
