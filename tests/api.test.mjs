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
