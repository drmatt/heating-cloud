// Heating dashboard: a single-page app on top of Supabase.
//
// Routes (in the URL hash):
//   #/signin  #/signup  #/forgot  #/new-password
//   #/claim            link a controller to this account
//   #/                 zones
//   #/zone/<id>        a zone's history and schedule
//   #/sensors          sensors, and adding new ones
//   #/settings         home, controller and account

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { config } from "./config.js?v=2026101916";
import { priceCurrent, priceTypicalMonth, currentSettings } from "./forecast.js?v=2026101916";

const app = document.getElementById("app");
const topbar = document.getElementById("topbar");
const banner = document.getElementById("banner");

if (!config.supabaseUrl || !config.supabaseKey) {
  app.innerHTML = `<div class="card narrow"><h1>Not set up yet</h1>
    <p>Add the Supabase project URL and publishable key to <code>config.js</code>.</p></div>`;
  throw new Error("config.js is missing the Supabase settings");
}

const supabase = createClient(config.supabaseUrl, config.supabaseKey);

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // show Monday first; the controller counts from Sunday
const ONLINE_WITHIN_MS = 2 * 60 * 1000;
// Colour-blind-safe colours (Okabe-Ito), checked with the palette validator.
// Charts also use patterns, so no two series differ by colour alone.
const SERIES = ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#56b4e9"];

// Patterns drawn over a colour, for charts (canvas) and swatches (CSS)
const PATTERNS = ["solid", "diagonal", "dots", "cross", "horizontal", "vertical", "back-diagonal"];

function chartPattern(color, kind) {
  if (kind == "solid") return color;
  const c = document.createElement("canvas");
  c.width = c.height = 10;
  const g = c.getContext("2d");
  g.fillStyle = color;
  g.fillRect(0, 0, 10, 10);
  g.strokeStyle = "rgba(255,255,255,0.85)";
  g.fillStyle = "rgba(255,255,255,0.85)";
  g.lineWidth = 2;
  const line = (x1, y1, x2, y2) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
  if (kind == "diagonal") { line(0, 10, 10, 0); line(-5, 5, 5, -5); line(5, 15, 15, 5); }
  if (kind == "back-diagonal") { line(0, 0, 10, 10); line(-5, 5, 5, 15); line(5, -5, 15, 5); }
  if (kind == "cross") { line(0, 10, 10, 0); line(0, 0, 10, 10); }
  if (kind == "horizontal") line(0, 5, 10, 5);
  if (kind == "vertical") line(5, 0, 5, 10);
  if (kind == "dots") { g.beginPath(); g.arc(5, 5, 1.8, 0, Math.PI * 2); g.fill(); }
  return g.createPattern(c, "repeat");
}

function swatchStyle(color, kind) {
  const w = "rgba(255,255,255,0.85)";
  const patterns = {
    solid: "",
    diagonal: `repeating-linear-gradient(-45deg, ${w} 0 2px, transparent 2px 5px),`,
    "back-diagonal": `repeating-linear-gradient(45deg, ${w} 0 2px, transparent 2px 5px),`,
    cross: `repeating-linear-gradient(45deg, ${w} 0 1.5px, transparent 1.5px 5px), repeating-linear-gradient(-45deg, ${w} 0 1.5px, transparent 1.5px 5px),`,
    horizontal: `repeating-linear-gradient(0deg, ${w} 0 2px, transparent 2px 5px),`,
    vertical: `repeating-linear-gradient(90deg, ${w} 0 2px, transparent 2px 5px),`,
    dots: `radial-gradient(${w} 1.2px, transparent 1.6px) 0 0 / 5px 5px,`,
  };
  return `background: ${patterns[kind] || ""} ${color};`;
}

let session = null;
let home = null; // { id, name }
let refreshTimer = null;
let chart = null;

// ---------------------------------------------------------------------------
// Helpers

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmtTemp = (t) => (t == null ? "–" : Number(t).toFixed(1) + "°");
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function fmtAgo(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString();
}

function message(kind, text) {
  return text ? `<div class="message ${kind}" role="${kind == "error" ? "alert" : "status"}">${esc(text)}</div>` : "";
}

function render(html) {
  app.innerHTML = html;
}

function go(route) {
  if (location.hash == route) route_();
  else location.hash = route;
}

function setNav(active) {
  topbar.hidden = !active;
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav == active));
  document.getElementById("home-name").textContent = home ? home.name : "Heating";
}

function every(ms, fn) {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(fn, ms);
}

function fail(error) {
  return error?.message || String(error);
}

// Disable a form's button while work runs, and show what happened
async function submitting(form, work) {
  const button = form.querySelector("button[type=submit]");
  const out = form.querySelector(".out");
  button.disabled = true;
  if (out) out.innerHTML = "";
  try {
    await work(out);
  } catch (error) {
    if (out) out.innerHTML = message("error", fail(error));
  }
  button.disabled = false;
}

// ---------------------------------------------------------------------------
// Data

async function loadHome() {
  const { data, error } = await supabase.from("homes").select("id, name").order("created_at").limit(1);
  if (error) throw error;
  home = data[0] || null;
  return home;
}

async function loadController() {
  const { data } = await supabase.from("controllers").select("id, name, last_seen_at, software_version").eq("home_id", home.id).maybeSingle();
  return data;
}

function showOfflineBanner(controller) {
  const online = controller?.last_seen_at && Date.now() - Date.parse(controller.last_seen_at) < ONLINE_WITHIN_MS;
  banner.hidden = online;
  if (!online) {
    banner.textContent = controller?.last_seen_at
      ? `Your controller was last online ${fmtAgo(controller.last_seen_at)}. The heating keeps running its schedule, but changes will wait until it reconnects.`
      : "Your controller hasn't connected yet.";
  }
}

// Queue work for the controller and wait for it to finish
async function runCommand(type, payload, timeoutMs, onWaiting) {
  const { data, error } = await supabase.from("commands").insert({ home_id: home.id, type, payload }).select("id").single();
  if (error) throw error;

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const { data: cmd } = await supabase.from("commands").select("status, result").eq("id", data.id).single();
    if (cmd.status == "done" || cmd.status == "failed") return cmd.result || {};
    if (onWaiting) onWaiting(cmd.status);
  }
  return { error: "The controller didn't respond. Check it's switched on and connected." };
}

// ---------------------------------------------------------------------------
// Accounts

function authPage(title, body, links) {
  setNav(null);
  banner.hidden = true;
  render(`<div class="card narrow">
    <h1>${title}</h1>
    ${body}
    <p class="small muted">${links}</p>
  </div>`);
}

function signInPage() {
  authPage(
    "Sign in",
    `<form id="f">
      <label for="email">Email</label><input id="email" type="email" autocomplete="email" required>
      <label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required>
      <div class="out"></div>
      <button class="primary full" type="submit">Sign in</button>
    </form>`,
    `<a href="#/signup">Create an account</a> · <a href="#/forgot">Forgotten password</a>`
  );
  const form = document.getElementById("f");
  form.onsubmit = (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const { error } = await supabase.auth.signInWithPassword({ email: form.email.value, password: form.password.value });
      if (error) throw error;
      go("#/");
    });
  };
}

function signUpPage() {
  authPage(
    "Create an account",
    `<form id="f">
      <label for="email">Email</label><input id="email" type="email" autocomplete="email" required>
      <label for="password">Password</label><input id="password" type="password" autocomplete="new-password" minlength="8" required>
      <div class="out"></div>
      <button class="primary full" type="submit">Create account</button>
    </form>`,
    `Already have an account? <a href="#/signin">Sign in</a>`
  );
  const form = document.getElementById("f");
  form.onsubmit = (e) => {
    e.preventDefault();
    submitting(form, async (out) => {
      const { data, error } = await supabase.auth.signUp({
        email: form.email.value,
        password: form.password.value,
        options: { emailRedirectTo: location.origin + location.pathname },
      });
      if (error) throw error;
      if (data.session) go("#/claim");
      else out.innerHTML = message("success", "Check your email for a link to confirm your account.");
    });
  };
}

function forgotPage() {
  authPage(
    "Reset your password",
    `<form id="f">
      <label for="email">Email</label><input id="email" type="email" autocomplete="email" required>
      <div class="out"></div>
      <button class="primary full" type="submit">Send reset link</button>
    </form>`,
    `<a href="#/signin">Back to sign in</a>`
  );
  const form = document.getElementById("f");
  form.onsubmit = (e) => {
    e.preventDefault();
    submitting(form, async (out) => {
      const { error } = await supabase.auth.resetPasswordForEmail(form.email.value, {
        redirectTo: location.origin + location.pathname + "#/new-password",
      });
      if (error) throw error;
      out.innerHTML = message("success", "If there's an account for that address, we've sent a reset link.");
    });
  };
}

function newPasswordPage() {
  authPage(
    "Choose a new password",
    `<form id="f">
      <label for="password">New password</label><input id="password" type="password" autocomplete="new-password" minlength="8" required>
      <div class="out"></div>
      <button class="primary full" type="submit">Save password</button>
    </form>`,
    ``
  );
  const form = document.getElementById("f");
  form.onsubmit = (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const { error } = await supabase.auth.updateUser({ password: form.password.value });
      if (error) throw error;
      go("#/");
    });
  };
}

// ---------------------------------------------------------------------------
// Claiming a controller

async function claimPage() {
  setNav(null);
  banner.hidden = true;
  const { data: invites } = await supabase.rpc("my_invites");
  render(`${(invites || []).map((i) => `<div class="card narrow">
      <h1>You're invited</h1>
      <p>You've been invited to share the heating at <strong>${esc(i.home_name)}</strong>.</p>
      <form class="join" data-invite="${i.id}"><div class="out"></div><button class="primary full" type="submit">Join ${esc(i.home_name)}</button></form>
    </div>`).join("")}
    <div class="card narrow">
    <h1>${invites?.length ? "Or connect your own controller" : "Connect your controller"}</h1>
    <p>Plug in your heating controller and connect it to your router. Then enter the code from its label, or from the controller's set-up page.</p>
    <form id="f">
      <label for="code">Controller code</label>
      <input id="code" class="code-input" placeholder="ABCD-EFGH" autocomplete="off" required>
      <label for="name">Name for this home</label>
      <input id="name" value="My home" maxlength="60" required>
      <div class="out"></div>
      <button class="primary full" type="submit">Connect</button>
    </form>
    <p class="small muted"><button class="link" id="signout">Sign out</button></p>
  </div>`);
  document.getElementById("signout").onclick = () => supabase.auth.signOut();
  app.querySelectorAll("form.join").forEach((join) => {
    join.onsubmit = (e) => {
      e.preventDefault();
      submitting(join, async () => {
        const { error } = await supabase.rpc("accept_invite", { p_invite: join.dataset.invite });
        if (error) throw error;
        await loadHome();
        go("#/");
      });
    };
  });
  const form = document.getElementById("f");
  form.onsubmit = (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const { error } = await supabase.rpc("claim_controller", { p_code: form.code.value, p_home_name: form.name.value });
      if (error) throw error;
      await loadHome();
      go("#/");
    });
  };
}

// ---------------------------------------------------------------------------
// Zones

const flame = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-7 1 2 1 3 3 4 0-3-1-6 0-9z"/></svg>`;

// How a zone is controlled, as a small label
function modePill(zone, hasSensor) {
  if (!hasSensor) return `<span class="pill">Timer</span>`;
  return zone.eco_enabled ? `<span class="pill smart">Intelligent</span>` : `<span class="pill">Programmer</span>`;
}

// Today's warm (or heating) times for a zone, as "07:00–09:00, 17:00–22:30"
function todayTimes(zone, intelligent, scheduleSlots) {
  const today = new Date().getDay();
  const slots = intelligent
    ? (zone.plan?.slots || []).filter((s) => s.day == today).map((s) => [s.from, s.to])
    : scheduleSlots.filter((s) => s.day == today).map((s) => [s.on_time.slice(0, 5), s.off_time.slice(0, 5)]);
  return slots.map(([a, b]) => `${a}–${b == "24:00" ? "midnight" : b}`).join(", ");
}

// info: { hasSensor, rooms: [names], slots: this zone's schedule slots }
function zoneCard(zone, info) {
  const boosted = zone.boost_until && Date.parse(zone.boost_until) > Date.now();
  const intelligent = zone.eco_enabled && info.hasSensor;
  const warming = zone.is_on && intelligent && zone.plan?.reason == "preheat";
  const status = zone.is_on
    ? `<span class="pill heat">${flame}${warming ? "Warming up" : "Heating"}</span>`
    : `<span class="pill">Off</span>`;
  const lowered = Number(zone.budget_offset) > 0 ? ` <span class="pill">Budget −${Number(zone.budget_offset)}°</span>` : "";
  const nudged = zone.comfort_bump_until && Date.parse(zone.comfort_bump_until) > Date.now() && Number(zone.comfort_bump)
    ? ` <span class="pill">${Number(zone.comfort_bump) > 0 ? "Warmer" : "Cooler"} until ${fmtTime(zone.comfort_bump_until)}</span>` : "";
  const target = zone.is_enabled && zone.desired_temp > 5 ? `<span class="muted small">Target ${fmtTemp(zone.desired_temp)}${lowered}${nudged}</span>` : "";
  const plan = zone.is_enabled ? planLine(zone) : "";
  const times = zone.is_enabled ? todayTimes(zone, intelligent, info.slots) : "";
  const when = !zone.is_enabled ? "Switched off"
    : times ? `${intelligent ? "Warm today" : info.hasSensor ? "Heating today" : "On today"} ${times}`
    : "Not heated today";
  const rooms = info.hasSensor
    ? info.rooms.length
      ? `<a class="small" href="#/rooms">${esc(info.rooms.join(", "))}</a>`
      : intelligent ? `<a class="small" href="#/rooms">Add its rooms</a>` : ""
    : "";

  return `<article class="card zone ${zone.is_enabled ? "" : "disabled"}">
    <div class="zone-head">
      <a href="#/zone/${zone.id}">${esc(zone.name)}</a>
      ${status}
    </div>
    <div class="row">${modePill(zone, info.hasSensor)}${zone.heater && zone.heater != "unknown" ? `<span class="pill">${HEATERS[zone.heater]}</span>` : ""}</div>
    <div class="temp">${zone.current_temp == null ? `<small>${info.hasSensor ? "No reading" : "No sensor"}</small>` : fmtTemp(zone.current_temp)}</div>
    ${target}
    <div class="zone-facts small">
      <span>${esc(when)}</span>
      ${plan ? `<span class="muted">${esc(plan)}</span>` : ""}
      ${rooms}
    </div>
    <div class="row">
      <label class="switch"><input type="checkbox" data-enable="${zone.id}" ${zone.is_enabled ? "checked" : ""}> Heating on</label>
      <span class="grow"></span>
      ${
        boosted
          ? `<span class="small muted">Boost until ${fmtTime(zone.boost_until)}</span>
             <button data-boost="${zone.id}" data-hours="0">Cancel</button>`
          : `<button data-boost="${zone.id}" data-hours="1">Boost 1 h</button>`
      }
    </div>
  </article>`;
}

// Whether the boiler is running: it fires whenever any zone (hot water
// included) calls for heat
function boilerCard(zones, controller) {
  const seen = controller?.last_seen_at ? Date.parse(controller.last_seen_at) : 0;
  if (!seen || Date.now() - seen > 5 * 60000) {
    return `<section class="card boiler"><div class="row"><span class="boiler-icon">${flame}</span>
      <div><strong>Boiler: not known</strong><div class="small muted">The controller hasn't reported for a while.</div></div></div></section>`;
  }
  const calling = zones.filter((z) => z.is_on);
  const next = zones
    .filter((z) => !z.is_on && z.is_enabled && z.eco_enabled && z.plan?.next_start && z.plan.next_start * 1000 > Date.now())
    .sort((a, b) => a.plan.next_start - b.plan.next_start)[0];
  const detail = calling.length
    ? `Heating ${calling.map((z) => esc(z.name)).join(", ")}`
    : next ? `Next on: ${esc(next.name)} about ${unixTime(next.plan.next_start)}` : "No zone needs heat right now";
  const updated = zones.map((z) => z.state_updated_at).filter(Boolean).sort().pop();
  return `<section class="card boiler ${calling.length ? "on" : ""}" aria-live="polite">
    <div class="row">
      <span class="boiler-icon">${flame}</span>
      <div class="grow"><strong>Boiler ${calling.length ? "on" : "off"}</strong><div class="small muted">${detail}</div></div>
      ${updated ? `<span class="small muted">Updated ${fmtAgo(updated)}</span>` : ""}
    </div>
  </section>`;
}

const HEATERS = { radiators: "Radiators", underfloor: "Underfloor heating", unknown: "Not sure" };
const unixTime = (t) => fmtTime(new Date(t * 1000).toISOString());

// In intelligent mode, what the controller is doing about the next warm period
function planLine(zone) {
  const p = zone.eco_enabled && zone.plan;
  if (!p || !p.next_period) return "";
  const by = unixTime(p.next_period);
  if (zone.is_on && p.reason == "preheat") return `Warming up for ${by}`;
  if (!zone.is_on && p.next_start && p.next_start * 1000 > Date.now() && p.next_start < p.next_period)
    return `Starts about ${unixTime(p.next_start)} to be warm by ${by}`;
  return "";
}

// Weekly warm periods [{day, from, to, temp}] in a few lines, with days
// that are the same grouped: "Mon–Fri 07:00–09:00, 17:00–22:30 at 20°"
function describeWarm(slots) {
  const short = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const byDay = [1, 2, 3, 4, 5, 6, 0].map((d) => ({
    d,
    text: slots.filter((s) => s.day == d).map((s) => `${s.from}–${s.to == "24:00" ? "midnight" : s.to}${s.temp ? " at " + fmtTemp(s.temp) : ""}`).join(", "),
  }));
  const lines = [];
  byDay.forEach((x) => {
    const last = lines[lines.length - 1];
    if (last && last.text == x.text) last.to = x.d;
    else lines.push({ from: x.d, to: x.d, text: x.text });
  });
  return lines.map((l) => `<li>${l.from == l.to ? short[l.from] : short[l.from] + "–" + short[l.to]}: ${esc(l.text || "not heated")}</li>`).join("");
}

// Asked once per zone with a sensor: what heats it, so look-ahead control
// can plan before it has learned the zone
function heaterQuestion(zones, sensorZoneIds) {
  const ask = zones.filter((z) => sensorZoneIds.has(z.id) && !z.heater);
  if (!ask.length) return "";
  return `<section class="card advice">
    <h3>How is each zone heated?</h3>
    <p class="small muted">Underfloor heating takes hours to warm up, radiators minutes. Knowing which helps the controller have rooms warm on time from the start; it learns the details as it goes.</p>
    ${ask.map((z) => `<div class="row"><span class="grow">${esc(z.name)}</span>
      <select data-heater="${z.id}" aria-label="How ${esc(z.name)} is heated" style="max-width:220px">
        <option value="">Choose…</option>
        ${Object.entries(HEATERS).map(([v, label]) => `<option value="${v}">${label}</option>`).join("")}
      </select></div>`).join("")}
  </section>`;
}

function bindHeaterSelects(onSaved) {
  app.querySelectorAll("[data-heater]").forEach((select) => {
    select.onchange = async () => {
      if (!select.value) return;
      const { error } = await supabase.from("zones").update({ heater: select.value }).eq("id", select.dataset.heater);
      if (error) return alert(fail(error));
      onSaved();
    };
  });
}

// Weather-adjusted energy figures. Before intelligent mode is switched on, fit
// heating minutes = a + b × heating degree days on days the heating ran;
// afterwards compare the last 7 days with what that baseline expects.
function energySummary(daily, sensorZones) {
  const byDay = {};
  for (const d of daily) {
    if (!sensorZones.has(d.zone_local_id)) continue;
    const day = (byDay[d.day] ||= { minutes: 0, eco: 0, hdd: null });
    day.minutes += d.boiler_minutes;
    day.eco += d.eco_minutes;
    if (d.hdd != null) day.hdd = Number(d.hdd);
  }
  const days = Object.keys(byDay).sort();
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const lastWeek = days.filter((d) => d >= weekAgo && d < today);
  const actual = lastWeek.reduce((s, d) => s + byDay[d].minutes, 0) / 60;
  const ecoStart = days.find((d) => byDay[d].eco > 0);

  const base = days.filter((d) => (!ecoStart || d < ecoStart) && byDay[d].minutes > 0 && byDay[d].hdd != null);
  let expected = null;
  if (ecoStart && base.length >= 30 && lastWeek.every((d) => byDay[d].hdd != null)) {
    const xs = base.map((d) => byDay[d].hdd);
    const ys = base.map((d) => byDay[d].minutes);
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / (xs.reduce((s, x) => s + (x - mx) ** 2, 0) || 1);
    const a = my - b * mx;
    expected = lastWeek.reduce((s, d) => s + Math.max(0, a + b * byDay[d].hdd), 0) / 60;
  }
  return { actual, expected, baseDays: base.length, ecoStart, days: lastWeek.length };
}

function energyCard(e) {
  if (!e.days) return "";
  let text = `<strong>${e.actual.toFixed(1)} h</strong> of heating in the last 7 days.`;
  if (e.expected != null && e.expected > 0) {
    const change = Math.round((1 - e.actual / e.expected) * 100);
    text += ` For this weather you'd usually expect about ${e.expected.toFixed(1)} h, so intelligent heating saved an estimated
      <strong>${change > 0 ? change + "%" : "nothing yet"}</strong>.
      <span class="small muted">Based on ${e.baseDays} days before intelligent heating was switched on. An estimate, not a meter reading.</span>`;
  } else if (!e.ecoStart) {
    text += ` <span class="small muted">Switch on intelligent heating for a zone to start saving; savings show here once it has run for a few days.</span>`;
  } else {
    text += ` <span class="small muted">Savings appear once there's enough history to compare with.</span>`;
  }
  return `<section class="card"><h3>Energy</h3><p>${text}</p></section>`;
}

function adviceBanner(n) {
  const action = n.kind == "switch_on" ? "Switch on" : "Switch off";
  return `<section class="card advice">
    <h3>${esc(n.title)}</h3>
    <p>${esc(n.body)}</p>
    <div class="row">
      <button class="primary" data-advice="${n.id}">${action}</button>
      <button data-dismiss="${n.id}">Not now</button>
    </div>
  </section>`;
}

async function zonesPage() {
  setNav("zones");
  const yearAgo = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const [{ data: zones, error }, controller, { data: notes }, { data: daily }, { data: sensors }, money, { data: rooms }, { data: slots }] = await Promise.all([
    supabase.from("zones").select("*").eq("home_id", home.id).order("local_id"),
    loadController(),
    supabase.from("notifications").select("*").eq("home_id", home.id).is("dismissed_at", null)
      .gte("created_at", new Date(Date.now() - 21 * 86400000).toISOString()).order("created_at", { ascending: false }).limit(1),
    supabase.from("zone_daily").select("zone_local_id, day, boiler_minutes, eco_minutes, hdd").eq("home_id", home.id).gte("day", yearAgo).limit(5000),
    supabase.from("sensors").select("zone_id").eq("home_id", home.id),
    loadBudget(),
    supabase.from("rooms").select("name, zone_id").eq("home_id", home.id).order("name"),
    supabase.from("schedule_slots").select("zone_id, day, on_time, off_time").eq("home_id", home.id).order("on_time"),
  ]);
  if (error) return render(message("error", fail(error)));
  showOfflineBanner(controller);

  every(15000, () => {
    if (location.hash == "" || location.hash == "#/") zonesPage();
  });

  if (!zones.length) {
    return render(`<h1>Zones</h1><div class="card">
      <p>Waiting for your controller to send its zones. This happens within a minute of it connecting.</p></div>`);
  }

  const zoneIdsWithSensors = new Set(sensors.map((s) => s.zone_id));
  const sensorZones = new Set(zones.filter((z) => zoneIdsWithSensors.has(z.id)).map((z) => z.local_id));

  render(`${(notes || []).map(adviceBanner).join("")}
    <div class="feel row">
      <button class="feel-cold" data-feel="cold">Too cold</button>
      <button class="feel-hot" data-feel="hot">Too hot</button>
    </div>
    <div id="feel-panel"></div>
    <h1>Zones</h1>
    ${boilerCard(zones, controller)}
    ${heaterQuestion(zones, zoneIdsWithSensors)}
    ${budgetCard(money.budget, money.plan, true)}
    <div class="zones">${zones.map((z) => zoneCard(z, {
      hasSensor: zoneIdsWithSensors.has(z.id),
      rooms: (rooms || []).filter((r) => r.zone_id == z.id).map((r) => r.name),
      slots: (slots || []).filter((s) => s.zone_id == z.id),
    })).join("")}</div>
    ${energyCard(energySummary(daily || [], sensorZones))}`);

  bindHeaterSelects(zonesPage);
  app.querySelectorAll("[data-heater]").forEach((select) => (select.onfocus = () => clearInterval(refreshTimer)));

  app.querySelectorAll("[data-feel]").forEach((button) => {
    button.onclick = () => {
      clearInterval(refreshTimer); // don't redraw while choosing a room
      comfortPanel(button.dataset.feel, zones);
    };
  });

  app.querySelectorAll("[data-advice]").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      const n = notes.find((x) => x.id == button.dataset.advice);
      const ids = n.action?.zone_local_ids || [];
      if (ids.length) {
        const { error } = await supabase.from("zones").update({ is_enabled: n.kind == "switch_on" })
          .eq("home_id", home.id).in("local_id", ids);
        if (error) return alert(fail(error));
      }
      await supabase.from("notifications").update({ dismissed_at: new Date().toISOString() }).eq("id", n.id);
      zonesPage();
    };
  });
  app.querySelectorAll("[data-dismiss]").forEach((button) => {
    button.onclick = async () => {
      await supabase.from("notifications").update({ dismissed_at: new Date().toISOString() }).eq("id", button.dataset.dismiss);
      zonesPage();
    };
  });

  app.querySelectorAll("[data-boost]").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      const hours = Number(button.dataset.hours);
      const boost_until = hours ? new Date(Date.now() + hours * 3600000).toISOString() : null;
      const { error } = await supabase.from("zones").update({ boost_until }).eq("id", button.dataset.boost);
      if (error) alert(fail(error));
      zonesPage();
    };
  });

  app.querySelectorAll("[data-enable]").forEach((box) => {
    box.onchange = async () => {
      const { error } = await supabase.from("zones").update({ is_enabled: box.checked }).eq("id", box.dataset.enable);
      if (error) alert(fail(error));
      zonesPage();
    };
  });
}

// ---------------------------------------------------------------------------
// One zone: history and schedule

async function zonePage(zoneId) {
  setNav("zones");
  clearInterval(refreshTimer);

  const since = new Date(Date.now() - 24 * 3600000).toISOString();
  const { data: zone, error } = await supabase.from("zones").select("*").eq("id", zoneId).single();
  if (error) return render(message("error", "Zone not found."));

  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [{ data: sensors }, { data: slots }, { data: events }, { data: daily }] = await Promise.all([
    supabase.from("sensors").select("device_id, name").eq("zone_id", zoneId),
    supabase.from("schedule_slots").select("day, on_time, off_time, temp").eq("zone_id", zoneId).order("on_time"),
    supabase.from("zone_events").select("time, value").eq("home_id", home.id).eq("zone_local_id", zone.local_id)
      .eq("type", "BOILER").gte("time", since).order("time"),
    supabase.from("zone_daily").select("day, boiler_minutes, eco_minutes, mean_outdoor").eq("home_id", home.id)
      .eq("zone_local_id", zone.local_id).gte("day", monthAgo).order("day"),
  ]);

  const ids = sensors.map((s) => s.device_id);
  const { data: readings } = ids.length
    ? await supabase.from("readings").select("device_id, time, temp").eq("home_id", home.id).in("device_id", ids)
        .gte("time", since).order("time").limit(5000)
    : { data: [] };

  // in intelligent mode, a zone with a sensor is warm when its rooms are used, and the
  // controller decides when to heat; the boiler schedule isn't shown
  const roomBased = zone.eco_enabled && ids.length > 0;

  render(`<p class="small"><a href="#/">← Zones</a></p>
    <h1>${esc(zone.name)}</h1>
    <section class="card">
      <h3>Last 24 hours</h3>
      ${ids.length ? `<div class="chart-wrap"><canvas id="chart" role="img" aria-label="Temperature in ${esc(zone.name)} over the last 24 hours, with times the heating was on"></canvas></div>`
        : `<p class="muted">No sensors in this zone. Add one on the <a href="#/sensors">Sensors</a> page.</p>`}
    </section>
    ${ids.length ? ecoSection(zone) : ""}
    ${comfortSection(zone, slots, roomBased)}
    ${daily.length ? `<section class="card">
      <h3>Heating time, last 30 days</h3>
      <div class="chart-wrap short"><canvas id="daily" role="img" aria-label="Hours of heating each day in ${esc(zone.name)} over the last 30 days"></canvas></div>
    </section>` : ""}
    ${roomBased ? warmSection(zone, slots) : `<section class="card">
      <h3>Schedule</h3>
      <p class="small muted">The heating comes on in these periods when the room is below the temperature you set.</p>
      <form id="schedule">
        <div id="days"></div>
        <div class="out"></div>
        <div class="row"><button class="primary" type="submit">Save schedule</button>
          <button type="button" id="copy">Copy Monday to weekdays</button></div>
      </form>
    </section>`}`);

  if (ids.length) drawChart(sensors, readings, events, since);
  if (daily.length) drawDaily(daily);
  if (ids.length) bindEco(zone);
  if (roomBased) bindWarm(zone);
  else scheduleEditor(zone, slots);

  document.getElementById("use-preferred")?.addEventListener("click", async (e) => {
    const temp = Number(e.target.dataset.temp);
    e.target.disabled = true;
    if (roomBased) {
      const { error } = await supabase.from("zones").update({ comfort_temp: temp }).eq("id", zone.id);
      if (error) return alert(fail(error));
      return zonePage(zone.id);
    }
    const { error } = await supabase.rpc("set_zone_schedule", {
      p_zone: zone.id,
      p_slots: slots.map((s) => ({ day: s.day, on_time: s.on_time.slice(0, 5), off_time: s.off_time.slice(0, 5), temp })),
    });
    if (error) return alert(fail(error));
    zonePage(zone.id);
  });
}

// What the controller has learned about the room, in plain words
function learnedText(model, plan) {
  if (!model) return "Still learning how this room heats and cools. This takes a week or two of heating.";
  const parts = [];
  if (plan && plan.warm_up_hours) {
    const learned = plan.learned >= 0.5 ? "" : " (typical figures until it has learned more)";
    parts.push(`takes about ${hoursText(plan.warm_up_hours)} to warm by 2 °C from cold, and keeps warming about ${Number(plan.carry_on).toFixed(1)} °C after the boiler stops${learned}`);
  }
  else if (model.h) parts.push(`warms about ${Number(model.h).toFixed(1)} °C an hour with the heating on`);
  if (model.k) parts.push(`loses about ${(model.k * 15).toFixed(1)} °C an hour when it's 5 °C outside`);
  if (model.overshoot) parts.push(`keeps warming about ${Number(model.overshoot).toFixed(1)} °C after the boiler switches off`);
  let text = parts.length ? "This room " + parts.join(", ") + "." : "";
  // 0.5 kW/m² is bright winter sunshine on a wall facing the sun
  if (model.usedSun) {
    const lift = Number(model.sun || 0) * 0.5;
    const facing = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(Number(model.facing) / 45)];
    text += lift >= 0.1 && model.facing != null
      ? ` Its windows seem to face ${facing}: bright sun on them warms it by about ${lift.toFixed(1)} °C an hour, so the heating does less on sunny days.`
      : " The sun makes little difference here.";
  }
  if (!model.ready) text += " Still learning: until it's confident it uses typical figures for this kind of heating.";
  else if (model.stale) text += " Learned last heating season.";
  return text;
}

function hoursText(h) {
  h = Number(h);
  if (h < 1) return Math.round(h * 60) + " minutes";
  const half = Math.round(h * 2) / 2;
  return (half == 1 ? "an hour" : half + " hours");
}

// Intelligent mode: when the zone is warm, from the rooms on the Rooms page
function warmSection(zone, scheduleSlots) {
  const p = zone.plan || {};
  const slots = p.slots || [];
  const temps = scheduleSlots.map((s) => Number(s.temp));
  const comfort = zone.comfort_temp != null ? Number(zone.comfort_temp) : temps.length ? Math.max(...temps) : 20;
  const options = [];
  for (let t = 16; t <= 23; t += 0.5) options.push(t);
  const source = {
    rooms: "From when you use its rooms. Change them on the <a href=\"#/rooms\">Rooms</a> page.",
    minimum: `Its rooms are rarely used, so it's kept at its minimum (${fmtTemp(zone.min_temp)}). Add times on the <a href="#/rooms">Rooms</a> page for when you'll use them.`,
    schedule: "No room times yet, so it follows its old schedule. Tell us when its rooms are used on the <a href=\"#/rooms\">Rooms</a> page.",
  }[p.source] || "Waiting for the controller.";
  const next = planLine(zone);
  return `<section class="card">
    <h3>When it's warm</h3>
    <p class="small">${source}</p>
    ${slots.length ? `<ul class="small">${describeWarm(slots)}</ul>` : ""}
    ${next ? `<p class="small">${esc(next)}.</p>` : ""}
    <label for="comfort-temp">Temperature when the rooms are in use</label>
    <select id="comfort-temp" style="max-width:200px">${options
      .map((t) => `<option value="${t}" ${t == comfort ? "selected" : ""}>${t.toFixed(1)} °C</option>`).join("")}</select>
    <p class="small muted">It aims to be within your comfort margin of this when each period starts, starting up to 6 hours early for slow heating.</p>
  </section>`;
}

function bindWarm(zone) {
  document.getElementById("comfort-temp").onchange = async (e) => {
    const { error } = await supabase.from("zones").update({ comfort_temp: Number(e.target.value) }).eq("id", zone.id);
    if (error) alert(fail(error));
  };
}

function ecoSection(zone) {
  const margins = [0, 0.5, 1, 1.5, 2];
  return `<section class="card">
    <h3>Intelligent heating</h3>
    <label class="switch"><input type="checkbox" id="eco" ${zone.eco_enabled ? "checked" : ""}> Intelligent: heat for when the rooms are used, and learn when to start and stop</label>
    <p class="small muted">${zone.eco_enabled
      ? "The controller decides when the boiler runs, so the rooms are warm when you use them."
      : "Off: the boiler runs during the schedule below, like a normal programmer."}</p>
    <label for="heater">What heats this zone</label>
    <select id="heater" style="max-width:220px">
      ${zone.heater ? "" : `<option value="">Choose…</option>`}
      ${Object.entries(HEATERS).map(([v, label]) => `<option value="${v}" ${zone.heater == v ? "selected" : ""}>${label}</option>`).join("")}
    </select>
    <label for="margin">Let the room drift below the target by up to</label>
    <select id="margin" style="max-width:200px">${margins
      .map((m) => `<option value="${m}" ${Number(zone.comfort_margin) == m ? "selected" : ""}>${m == 0 ? "Never below target" : m + " °C"}</option>`)
      .join("")}</select>
    <p class="small muted">${esc(learnedText(zone.model, zone.plan))}</p>
    ${zone.is_enabled ? "" : `<p class="small muted">This zone is switched off. Its sensors check in once a day to save battery; press a sensor's button to wake it straight away.</p>`}
    <div class="out"></div>
  </section>`;
}

function bindEco(zone) {
  const save = async (fields) => {
    const { error } = await supabase.from("zones").update(fields).eq("id", zone.id);
    if (error) alert(fail(error));
  };
  document.getElementById("eco").onchange = async (e) => {
    await save({ eco_enabled: e.target.checked });
    zonePage(zone.id);
  };
  document.getElementById("heater").onchange = (e) => e.target.value && save({ heater: e.target.value });
  document.getElementById("margin").onchange = (e) => save({ comfort_margin: Number(e.target.value) });
}

let dailyChart = null;

function drawDaily(daily) {
  if (dailyChart) dailyChart.destroy();
  const style = getComputedStyle(document.documentElement);
  const muted = style.getPropertyValue("--muted").trim();
  const grid = style.getPropertyValue("--border").trim();
  dailyChart = new Chart(document.getElementById("daily"), {
    type: "bar",
    data: {
      labels: daily.map((d) => new Date(d.day).toLocaleDateString([], { day: "numeric", month: "short" })),
      datasets: [{
        label: "Hours of heating",
        data: daily.map((d) => Math.round((d.boiler_minutes / 60) * 10) / 10),
        backgroundColor: SERIES[0],
        borderRadius: 4,
        maxBarThickness: 18,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const d = daily[item.dataIndex];
              const out = d.mean_outdoor == null ? "" : `, ${Number(d.mean_outdoor).toFixed(1)} °C outside`;
              return `${item.parsed.y} h${out}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12 } },
        y: { grid: { color: grid }, ticks: { color: muted, callback: (v) => v + " h" }, beginAtZero: true },
      },
    },
  });
}

function drawChart(sensors, readings, events, since) {
  if (chart) chart.destroy();
  const start = Date.parse(since);
  const end = Date.now();
  const style = getComputedStyle(document.documentElement);
  const muted = style.getPropertyValue("--muted").trim();
  const grid = style.getPropertyValue("--border").trim();
  const heat = style.getPropertyValue("--heat").trim();

  const datasets = sensors.map((s, i) => ({
    label: s.name,
    data: readings.filter((r) => r.device_id == s.device_id).map((r) => ({ x: Date.parse(r.time), y: Number(r.temp) })),
    borderColor: SERIES[i % SERIES.length],
    backgroundColor: SERIES[i % SERIES.length],
    borderWidth: 2,
    borderDash: [[], [6, 3], [2, 2], [8, 3, 2, 3]][i % 4],
    pointRadius: 0,
    stepped: "before",
    yAxisID: "y",
  }));

  // heating on/off as a shaded band along the bottom
  const heating = [];
  let on = false;
  heating.push({ x: start, y: 0 });
  for (const e of events) {
    const x = Date.parse(e.time);
    heating.push({ x, y: on ? 1 : 0 });
    on = e.value == "ON";
    heating.push({ x, y: on ? 1 : 0 });
  }
  heating.push({ x: end, y: on ? 1 : 0 });

  datasets.push({
    label: "Heating on",
    data: heating,
    stepped: true,
    borderWidth: 0,
    pointRadius: 0,
    fill: "origin",
    backgroundColor: chartPattern(heat + "55", "diagonal"),
    yAxisID: "heat",
  });

  chart = new Chart(document.getElementById("chart"), {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      plugins: {
        legend: { labels: { color: muted, boxWidth: 12 } },
        tooltip: {
          filter: (item) => item.dataset.yAxisID == "y",
          callbacks: {
            title: (items) => new Date(items[0].parsed.x).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            label: (item) => `${item.dataset.label}: ${item.parsed.y.toFixed(1)}°C`,
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: start,
          max: end,
          grid: { display: false },
          ticks: {
            color: muted,
            stepSize: 3 * 3600000,
            callback: (v) => new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          },
        },
        y: { grid: { color: grid }, ticks: { color: muted, callback: (v) => v + "°" } },
        heat: { display: false, min: 0, max: 8 },
      },
    },
  });
}

function scheduleEditor(zone, slots) {
  const byDay = {};
  for (const d of DAY_ORDER) byDay[d] = [];
  for (const s of slots) byDay[s.day].push({ on: s.on_time.slice(0, 5), off: s.off_time.slice(0, 5), temp: Number(s.temp) });

  const daysEl = document.getElementById("days");

  function draw() {
    daysEl.innerHTML = DAY_ORDER.map(
      (d) => `<div class="day">
        <div class="day-head"><strong>${DAYS[d]}</strong><button type="button" class="link" data-add="${d}">Add period</button></div>
        ${byDay[d].length ? "" : `<p class="small muted">Off all day</p>`}
        ${byDay[d]
          .map(
            (s, i) => `<div class="slot">
              <input type="time" aria-label="${DAYS[d]} period ${i + 1} on" data-d="${d}" data-i="${i}" data-f="on" value="${s.on}" required>
              <input type="time" aria-label="${DAYS[d]} period ${i + 1} off" data-d="${d}" data-i="${i}" data-f="off" value="${s.off}" required>
              <input type="number" aria-label="${DAYS[d]} period ${i + 1} temperature" data-d="${d}" data-i="${i}" data-f="temp" value="${s.temp}" min="5" max="30" step="0.5" required>
              <button type="button" class="link" data-remove="${d}:${i}" aria-label="Remove ${DAYS[d]} period ${i + 1}">Remove</button>
            </div>`
          )
          .join("")}
      </div>`
    ).join("");

    daysEl.querySelectorAll("input").forEach((input) => {
      input.onchange = () => {
        const slot = byDay[input.dataset.d][input.dataset.i];
        slot[input.dataset.f] = input.dataset.f == "temp" ? Number(input.value) : input.value;
      };
    });
    daysEl.querySelectorAll("[data-add]").forEach((b) => {
      b.onclick = () => {
        const day = byDay[b.dataset.add];
        const last = day[day.length - 1];
        day.push(last ? { on: last.off, off: "23:00", temp: last.temp } : { on: "07:00", off: "09:00", temp: 20 });
        draw();
      };
    });
    daysEl.querySelectorAll("[data-remove]").forEach((b) => {
      b.onclick = () => {
        const [d, i] = b.dataset.remove.split(":");
        byDay[d].splice(Number(i), 1);
        draw();
      };
    });
  }

  draw();

  document.getElementById("copy").onclick = () => {
    for (const d of [2, 3, 4, 5]) byDay[d] = byDay[1].map((s) => ({ ...s }));
    draw();
  };

  const form = document.getElementById("schedule");
  form.onsubmit = (e) => {
    e.preventDefault();
    submitting(form, async (out) => {
      const p_slots = [];
      for (const d of DAY_ORDER) {
        for (const s of byDay[d]) {
          if (s.off <= s.on) throw new Error(`${DAYS[d]}: each period must end after it starts.`);
          p_slots.push({ day: d, on_time: s.on, off_time: s.off, temp: s.temp });
        }
      }
      const { error } = await supabase.rpc("set_zone_schedule", { p_zone: zone.id, p_slots });
      if (error) throw error;
      out.innerHTML = message("success", "Saved. The controller picks up changes within a minute.");
    });
  };
}

// ---------------------------------------------------------------------------
// Sensors

async function sensorsPage() {
  setNav("sensors");
  clearInterval(refreshTimer);

  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const [{ data: sensors }, { data: zones }, { data: recent }, { data: lastNetwork }, controller] = await Promise.all([
    supabase.from("sensors").select("*").eq("home_id", home.id).order("name"),
    supabase.from("zones").select("id, local_id, name").eq("home_id", home.id).order("local_id"),
    supabase.from("readings").select("device_id, time").eq("home_id", home.id).gte("time", weekAgo).order("time", { ascending: false }).limit(2000),
    supabase.from("commands").select("result").eq("home_id", home.id).eq("type", "set_sensor_network").eq("status", "done")
      .order("created_at", { ascending: false }).limit(1),
    loadController(),
  ]);
  showOfflineBanner(controller);

  const known = new Set(sensors.map((s) => s.device_id));
  const unassigned = [...new Set(recent.map((r) => r.device_id))].filter((id) => !known.has(id));
  const zoneName = Object.fromEntries(zones.map((z) => [z.id, z.name]));
  const zoneOptions = (selected) => zones.map((z) => `<option value="${z.id}" ${z.id == selected ? "selected" : ""}>${esc(z.name)}</option>`).join("");
  const ssid = lastNetwork?.[0]?.result?.ssid;

  render(`<h1>Sensors</h1>
    <section class="card">
      ${sensors.length ? `<table>
        <thead><tr><th>Name</th><th class="hide-small">Zone</th><th>Last reading</th><th class="hide-small">Battery</th><th></th></tr></thead>
        <tbody>${sensors
          .map(
            (s) => `<tr>
              <td>${esc(s.name)}<div class="small muted">${esc(s.device_id)}</div></td>
              <td class="hide-small">${esc(zoneName[s.zone_id] || "–")}</td>
              <td class="num">${fmtTemp(s.last_temp)}<div class="small muted">${fmtAgo(s.last_seen_at)}</div></td>
              <td class="num hide-small">${s.last_battery ?? "–"}</td>
              <td><button class="link" data-edit="${esc(s.device_id)}">Edit</button></td>
            </tr>
            <tr hidden id="edit-${esc(s.device_id)}"><td colspan="5">
              <form class="row" data-save="${esc(s.device_id)}">
                <input class="grow" name="name" value="${esc(s.name)}" maxlength="20" required aria-label="Name">
                <select class="grow" name="zone" aria-label="Zone">${zoneOptions(s.zone_id)}</select>
                <button class="primary" type="submit">Save</button>
                <button type="button" class="danger" data-remove="${esc(s.device_id)}">Remove</button>
              </form>
            </td></tr>`
          )
          .join("")}</tbody></table>` : `<p class="muted">No sensors yet.</p>`}
    </section>

    ${unassigned.length ? `<section class="card"><h3>Sensors without a room</h3>
      <p class="small muted">These are sending readings but haven't been named.</p>
      ${unassigned.map((id) => `<form class="row" data-save="${esc(id)}" style="margin-top:8px">
        <code class="grow">${esc(id)}</code>
        <input class="grow" name="name" placeholder="Name" maxlength="20" required aria-label="Name for ${esc(id)}">
        <select class="grow" name="zone" aria-label="Zone for ${esc(id)}">${zoneOptions()}</select>
        <button class="primary" type="submit">Save</button></form>`).join("")}
    </section>` : ""}

    <h2>Add a sensor</h2>
    <section class="card">
      <h3>1. Wi-Fi for sensors</h3>
      <p class="small muted">${ssid ? `Sensors join <strong>${esc(ssid)}</strong>. Change it here if needed.` : "Enter the Wi-Fi network your sensors should join."}</p>
      <form id="network" class="row">
        <input class="grow" name="ssid" placeholder="Network name" value="${esc(ssid || "")}" required aria-label="Network name">
        <input class="grow" name="pass" type="password" placeholder="Password" autocomplete="off" aria-label="Wi-Fi password">
        <button type="submit">Save</button>
        <div class="out" style="width:100%"></div>
      </form>
    </section>
    <section class="card">
      <h3>2. Find the sensor</h3>
      <p class="small muted">Press the sensor's reset button, then press it again while its light is on. The light blinks while it waits. It must be near the controller.</p>
      <form id="scan"><button class="primary" type="submit">Search for sensors</button><div class="out"></div></form>
      <div id="found"></div>
    </section>`);

  app.querySelectorAll("[data-edit]").forEach((b) => {
    b.onclick = () => {
      const row = document.getElementById("edit-" + b.dataset.edit);
      row.hidden = !row.hidden;
    };
  });

  app.querySelectorAll("form[data-save]").forEach((form) => {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const { error } = await supabase.rpc("save_sensor", {
        p_home: home.id,
        p_device: form.dataset.save,
        p_name: form.name.value,
        p_zone: form.zone.value || null,
      });
      if (error) return alert(fail(error));
      sensorsPage();
    };
  });

  app.querySelectorAll("[data-remove]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Remove this sensor? Its past readings are kept.")) return;
      const { error } = await supabase.rpc("remove_sensor", { p_home: home.id, p_device: b.dataset.remove });
      if (error) return alert(fail(error));
      sensorsPage();
    };
  });

  const network = document.getElementById("network");
  network.onsubmit = (e) => {
    e.preventDefault();
    submitting(network, async (out) => {
      out.innerHTML = message("info", "Sending to your controller…");
      const result = await runCommand("set_sensor_network", { ssid: network.ssid.value.trim(), pass: network.pass.value }, 60000);
      if (result.error) throw new Error(result.error);
      network.pass.value = "";
      out.innerHTML = message("success", "Saved on your controller.");
    });
  };

  const scan = document.getElementById("scan");
  scan.onsubmit = (e) => {
    e.preventDefault();
    submitting(scan, async (out) => {
      const found = document.getElementById("found");
      found.innerHTML = "";
      out.innerHTML = message("info", "Searching near your controller…");
      const result = await runCommand("scan_sensors", {}, 60000);
      if (result.error) throw new Error(result.error);
      if (!result.sensors?.length) {
        out.innerHTML = message("info", "No sensors found. Check the sensor's light is blinking, then search again.");
        return;
      }
      out.innerHTML = "";
      found.innerHTML = result.sensors
        .map(
          (s) => `<form class="row" data-pair="${esc(s.address)}" style="margin-top:12px">
            <span class="grow">${esc(s.name || s.address)}</span>
            <input class="grow" name="name" placeholder="Room name" maxlength="20" required aria-label="Room name">
            <select class="grow" name="zone" aria-label="Zone">${zones.map((z) => `<option value="${z.local_id}">${esc(z.name)}</option>`).join("")}</select>
            <button class="primary" type="submit">Set up</button>
            <div class="out" style="width:100%"></div>
          </form>`
        )
        .join("");
      found.querySelectorAll("form[data-pair]").forEach((form) => {
        form.onsubmit = (e) => {
          e.preventDefault();
          submitting(form, async (out) => {
            out.innerHTML = message("info", "Setting up the sensor. This can take a couple of minutes.");
            const result = await runCommand(
              "pair_sensor",
              { address: form.dataset.pair, name: form.name.value, zone_local_id: Number(form.zone.value) },
              5 * 60000
            );
            if (result.error) throw new Error(result.error);
            out.innerHTML = message(result.warning ? "info" : "success", result.warning || `${form.name.value} is set up.`);
            setTimeout(sensorsPage, 3000);
          });
        };
      });
    });
  };
}

// ---------------------------------------------------------------------------
// Settings

async function settingsPage() {
  setNav("settings");
  clearInterval(refreshTimer);
  const [controller, { data: place }] = await Promise.all([
    loadController(),
    supabase.from("homes").select("latitude, longitude").eq("id", home.id).single(),
  ]);
  showOfflineBanner(controller);

  render(`<h1>Settings</h1>
    <section class="card">
      <h3>Home</h3>
      <form id="home" class="row">
        <input class="grow" name="name" value="${esc(home.name)}" maxlength="60" required aria-label="Home name">
        <button type="submit">Rename</button>
        <div class="out" style="width:100%"></div>
      </form>
    </section>
    <section class="card">
      <h3>Location</h3>
      <p class="small muted">Used to get the outside temperature, which helps the heating learn and tells you when to switch it on or off.
        Rounded to about 1 km. Weather from <a href="https://open-meteo.com/">Open-Meteo</a>.</p>
      <form id="location" class="row">
        <input class="grow" name="lat" inputmode="decimal" placeholder="Latitude" value="${esc(place?.latitude ?? "")}" aria-label="Latitude">
        <input class="grow" name="lon" inputmode="decimal" placeholder="Longitude" value="${esc(place?.longitude ?? "")}" aria-label="Longitude">
        <button type="button" id="here">Use my location</button>
        <button type="submit">Save</button>
        <div class="out" style="width:100%"></div>
      </form>
    </section>
    <section class="card">
      <h3>People</h3>
      <div id="people"><p class="muted small">Loading…</p></div>
    </section>
    <section class="card">
      <h3>Controller</h3>
      ${controller ? `<p>Last online: ${fmtAgo(controller.last_seen_at)}<br>
        <span class="small muted">Software ${esc(controller.software_version || "unknown")}</span></p>` : `<p class="muted">No controller.</p>`}
    </section>
    <section class="card">
      <h3>Account</h3>
      <p>${esc(session.user.email)}</p>
      <button id="signout">Sign out</button>
    </section>`);

  const form = document.getElementById("home");
  form.onsubmit = (e) => {
    e.preventDefault();
    submitting(form, async (out) => {
      const { error } = await supabase.from("homes").update({ name: form.name.value.trim() }).eq("id", home.id);
      if (error) throw error;
      home.name = form.name.value.trim();
      setNav("settings");
      out.innerHTML = message("success", "Saved.");
    });
  };

  const loc = document.getElementById("location");
  const round2 = (v) => Math.round(Number(v) * 100) / 100;
  document.getElementById("here").onclick = () => {
    const out = loc.querySelector(".out");
    if (!navigator.geolocation) return (out.innerHTML = message("error", "This browser can't share its location."));
    navigator.geolocation.getCurrentPosition(
      (p) => {
        loc.lat.value = round2(p.coords.latitude);
        loc.lon.value = round2(p.coords.longitude);
        out.innerHTML = message("info", "Check it, then Save.");
      },
      () => (out.innerHTML = message("error", "Couldn't get your location. Type it in instead."))
    );
  };
  loc.onsubmit = (e) => {
    e.preventDefault();
    submitting(loc, async (out) => {
      const lat = loc.lat.value.trim() === "" ? null : round2(loc.lat.value);
      const lon = loc.lon.value.trim() === "" ? null : round2(loc.lon.value);
      if ((lat == null) != (lon == null) || (lat != null && (Math.abs(lat) > 90 || Math.abs(lon) > 180 || isNaN(lat) || isNaN(lon)))) {
        throw new Error("Enter both latitude and longitude, or leave both empty.");
      }
      const { error } = await supabase.from("homes").update({ latitude: lat, longitude: lon }).eq("id", home.id);
      if (error) throw error;
      out.innerHTML = message("success", "Saved. Your controller picks it up within a minute.");
    });
  };

  document.getElementById("signout").onclick = () => supabase.auth.signOut();
  peopleSection();
}

// Who can use this home's heating, and inviting others
async function peopleSection() {
  const box = document.getElementById("people");
  const { data: people, error } = await supabase.rpc("home_people", { p_home: home.id });
  if (error) return (box.innerHTML = message("error", fail(error)));
  const isOwner = people.some((p) => p.is_you && p.role == "owner");
  const label = { owner: "Owner", member: "Can use the heating", invited: "Invited, not joined yet" };
  box.innerHTML = `<table><tbody>${people.map((p) => `<tr>
      <td>${esc(p.email)}${p.is_you ? ' <span class="small muted">(you)</span>' : ""}<div class="small muted">${label[p.role] || p.role}</div></td>
      <td>${isOwner && !p.is_you && p.role != "owner" ? `<button class="link danger" data-remove-user="${p.user_id || ""}" data-remove-invite="${p.invite_id || ""}">${p.invited ? "Cancel" : "Remove"}</button>` : ""}</td>
    </tr>`).join("")}</tbody></table>
    ${isOwner ? `<form id="invite" class="row" style="margin-top:12px">
      <input class="grow" name="email" type="email" placeholder="Their email address" required aria-label="Email address to invite">
      <button class="primary" type="submit">Invite</button>
      <div class="out" style="width:100%"></div></form>
      <p class="small muted">They sign in (or create an account) at ${esc(location.origin + location.pathname)} with that email, and can then control the heating. Only you can invite or remove people.</p>`
      : `<p class="small muted">Only the owner can invite or remove people.</p>`}`;

  box.querySelectorAll("[data-remove-user]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Remove their access?")) return;
      const { error } = await supabase.rpc("remove_member", {
        p_home: home.id,
        p_user: b.dataset.removeUser || null,
        p_invite: b.dataset.removeInvite || null,
      });
      if (error) return alert(fail(error));
      peopleSection();
    };
  });
  const invite = document.getElementById("invite");
  if (invite) {
    invite.onsubmit = (e) => {
      e.preventDefault();
      submitting(invite, async () => {
        const { error } = await supabase.rpc("invite_member", { p_home: home.id, p_email: invite.email.value });
        if (error) throw error;
        peopleSection();
      });
    };
  }
}

// ---------------------------------------------------------------------------
// Too hot / too cold

async function comfortPanel(feeling, zones) {
  const panel = document.getElementById("feel-panel");
  const { data: rooms } = await supabase.from("rooms").select("id, name, zone_id, has_trv").eq("home_id", home.id).order("name");
  const zoneById = Object.fromEntries(zones.map((z) => [z.id, z]));
  const choices = rooms.filter((r) => zoneById[r.zone_id]).map((r) => ({ room: r, zone: zoneById[r.zone_id], label: r.name }));
  // zones with no rooms listed are offered whole
  zones.filter((z) => !rooms.some((r) => r.zone_id == z.id)).forEach((z) => choices.push({ room: null, zone: z, label: z.name }));

  panel.innerHTML = `<section class="card">
    <h3>Where is it too ${feeling == "cold" ? "cold" : "hot"}?</h3>
    <div class="row">${choices.map((c, i) => `<button data-choice="${i}">${esc(c.label)}</button>`).join("")}
      <button class="link" id="feel-cancel">Cancel</button></div>
    <div class="out"></div>
  </section>`;
  document.getElementById("feel-cancel").onclick = () => zonesPage();
  panel.querySelectorAll("[data-choice]").forEach((b) => {
    b.onclick = async () => {
      const c = choices[Number(b.dataset.choice)];
      const out = panel.querySelector(".out");
      panel.querySelectorAll("button").forEach((x) => (x.disabled = true));
      try {
        out.innerHTML = message("info", await reportComfort(feeling, c.zone, c.room));
      } catch (error) {
        out.innerHTML = message("error", fail(error));
      }
      setTimeout(zonesPage, 6000);
    };
  });
}

async function reportComfort(feeling, zone, room) {
  const { data, error } = await supabase.rpc("report_comfort", { p_zone: zone.id, p_room: room?.id ?? null, p_feeling: feeling });
  if (error) throw error;
  const where = room ? room.name : zone.name;
  const temp = data.room_temp == null ? null : Number(data.room_temp);
  const target = data.target_temp == null ? null : Number(data.target_temp);
  const scheduled = data.enabled && target != null && target > 5;
  const notes = [];

  if (feeling == "cold" && !scheduled) {
    // nothing scheduled now: heat it for an hour
    const { error: e2 } = await supabase.from("zones").update({ boost_until: new Date(Date.now() + 3600000).toISOString() }).eq("id", zone.id);
    if (e2) throw e2;
    notes.push(`${zone.name} isn't scheduled to heat now, so it's on for the next hour.`);
  } else if (feeling == "hot" && !scheduled) {
    notes.push(`${zone.name}'s heating is already off. Opening a window or turning down the radiator valve${room ? " in " + room.name : ""} will help.`);
  } else {
    notes.push(`${zone.name} will be ${feeling == "cold" ? "warmer" : "cooler"} by ${Math.abs(data.bump)} °C for the next two hours.`);
    // the zone is where it should be, so the room itself is the problem
    if (room?.has_trv && temp != null && feeling == "cold" && temp >= target - 0.25) {
      notes.push(`${zone.name} is already at its target (${fmtTemp(temp)}), so try turning up the radiator valve in ${room.name} as well.`);
    }
    if (room?.has_trv && temp != null && feeling == "hot" && temp <= target + 0.25) {
      notes.push(`${zone.name} is at its target (${fmtTemp(temp)}), so turning down the radiator valve in ${room.name} will help most.`);
    }
  }
  notes.push("Thanks. This helps the heating learn what's comfortable for you.");
  return notes.join(" ");
}

// What the controller has learned from feedback, on a zone's page
function comfortSection(zone, slots, roomBased) {
  const preferred = zone.comfort_preferred == null ? null : Number(zone.comfort_preferred);
  if (preferred == null) return "";
  const targets = roomBased
    ? [zone.comfort_temp != null ? Number(zone.comfort_temp) : Math.max(...slots.map((s) => Number(s.temp)), 20)]
    : [...new Set(slots.map((s) => Number(s.temp)))];
  const same = targets.length == 1 && targets[0] == preferred;
  return `<section class="card">
    <h3>Comfort</h3>
    <p>From your feedback (${zone.comfort_reports} reports), you seem comfortable at about <strong>${fmtTemp(preferred)}</strong> here.
      ${targets.length ? `${roomBased ? "It aims for" : "The schedule aims for"} ${targets.map(fmtTemp).join(", ")}.` : ""}</p>
    ${same ? "" : `<button id="use-preferred" data-temp="${preferred}">Use ${fmtTemp(preferred)}${roomBased ? "" : " for the whole schedule"}</button>`}
    <div class="out"></div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Budget

const pounds = (pence) => "£" + (pence / 100).toFixed(2);
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function budgetStatus(plan) {
  if (!plan) return { text: "Planning…", kind: "info" };
  if (!plan.achievable) return { text: "Can't meet the budget at your minimum temperatures", kind: "error" };
  if (plan.suggestions?.length && plan.forecast_pence > plan.budget_pence) return { text: "Needs your approval to stay within budget", kind: "error" };
  if (plan.automatic?.length) return { text: `Saving to stay within budget (${plan.automatic.length} change${plan.automatic.length == 1 ? "" : "s"})`, kind: "info" };
  return { text: "On track", kind: "success" };
}

function budgetCard(budget, plan, compact) {
  if (!budget) {
    return compact ? "" : `<section class="card"><h3>Monthly budget</h3><p>Set a monthly budget and the heating will plan to stay within it.</p></section>`;
  }
  const status = budgetStatus(plan);
  const spent = plan ? plan.spent_pence : 0;
  const forecast = plan ? plan.forecast_pence : null;
  const pct = (v) => Math.min(100, Math.round((v / budget.monthly_pence) * 100));
  return `<section class="card budget">
    <div class="row"><h3 class="grow" style="margin:0">Budget this month</h3>${compact ? `<a href="#/budget" class="small">Details</a>` : ""}</div>
    <div class="bar" role="img" aria-label="Spent ${pounds(spent)} of ${pounds(budget.monthly_pence)}${forecast != null ? `, heading for ${pounds(forecast)}` : ""}">
      <span class="spent" style="width:${pct(spent)}%"></span>
      ${forecast != null ? `<span class="forecast" style="width:${pct(forecast)}%"></span>` : ""}
    </div>
    <p><strong>${pounds(spent)}</strong> spent of <strong>${pounds(budget.monthly_pence)}</strong>${forecast != null ? `, heading for about <strong>${pounds(forecast)}</strong>` : ""}.
      ${plan?.estimated ? `<span class="small muted">Partly estimated from boiler time.</span>` : ""}</p>
    ${message(status.kind, status.text)}
    ${!compact && forecast != null ? `<button id="try-changes" type="button">Try your own changes</button>` : ""}
  </section>`;
}

async function loadBudget() {
  const [{ data: budget }, { data: plan }] = await Promise.all([
    supabase.from("budgets").select("*").eq("home_id", home.id).maybeSingle(),
    supabase.from("budget_plans").select("*").eq("home_id", home.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  return { budget, plan };
}

async function askAssistant(mode, messages) {
  const { data, error } = await supabase.functions.invoke("assistant", { body: { mode, messages } });
  if (error) {
    let text = error.message;
    try {
      text = (await error.context.json()).error || text;
    } catch {}
    throw new Error(text);
  }
  if (data.error) throw new Error(data.error);
  return data;
}

function chatBox(id, placeholder) {
  return `<div class="chat" id="${id}">
    <div class="chat-log"></div>
    <form class="row"><input class="grow" name="q" placeholder="${esc(placeholder)}" autocomplete="off" required aria-label="${esc(placeholder)}">
      <button class="primary" type="submit">Send</button><div class="out" style="width:100%"></div></form>
  </div>`;
}

// A chat with the assistant; onProposal gets any structured proposal
function bindChat(id, mode, onProposal) {
  const box = document.getElementById(id);
  const log = box.querySelector(".chat-log");
  const form = box.querySelector("form");
  const history = [];
  const add = (role, text) => {
    const p = document.createElement("p");
    p.className = "chat-" + role;
    p.textContent = text;
    log.appendChild(p);
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const q = form.q.value.trim();
    if (!q) return;
    submitting(form, async () => {
      add("user", q);
      history.push({ role: "user", content: q });
      form.q.value = "";
      const result = await askAssistant(mode, history);
      add("assistant", result.reply);
      history.push({ role: "assistant", content: result.reply });
      if (result.proposal && onProposal) onProposal(result.proposal);
    });
  };
}

// ---------------------------------------------------------------------------
// What if: try other temperatures and times and see the month's cost, priced
// in the browser from the kit the controller uploads each hour (forecast.js)

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKEND = [0, 6];

// A zone's slots as the editor shows them: one temperature, and the times
// for weekdays and for weekends (Monday's and Saturday's)
function editableZone(z) {
  const temps = z.slots.map((s) => s.temp);
  const times = (day) => z.slots.filter((s) => s.day == day).sort((a, b) => a.from.localeCompare(b.from))
    .map((s) => [s.from, s.to == "24:00" ? "23:59" : s.to]);
  const weekday = times(1);
  const weekend = times(6);
  const same = (day, list) => JSON.stringify(times(day)) == JSON.stringify(list);
  const simple = WEEK.every((d) => same(d, weekday)) && WEEKEND.every((d) => same(d, weekend)) && new Set(temps).size <= 1;
  return { enabled: z.enabled, temp: temps.length ? Math.max(...temps) : 20, weekday, weekend, simple, changed: false };
}

function slotsFrom(e, z) {
  const temp = z.has_sensors ? e.temp : z.slots[0]?.temp ?? 20;
  const out = [];
  WEEK.forEach((day) => e.weekday.forEach(([from, to]) => out.push({ day, from, to, temp })));
  WEEKEND.forEach((day) => e.weekend.forEach(([from, to]) => out.push({ day, from, to, temp })));
  return out.filter((s) => s.to > s.from);
}

function whatIfTimes(zoneId, group, list) {
  return `<div class="whatif-times"><span class="small muted">${group == "weekday" ? "Weekdays" : "Weekends"}</span>
    ${list.map(([from, to], i) => `<span class="whatif-period">
      <input type="time" value="${from}" data-wz="${zoneId}" data-group="${group}" data-i="${i}" data-end="0" aria-label="${group} period ${i + 1} from">
      –<input type="time" value="${to}" data-wz="${zoneId}" data-group="${group}" data-i="${i}" data-end="1" aria-label="${group} period ${i + 1} to">
      <button type="button" class="link danger" data-wremove="${zoneId}" data-group="${group}" data-i="${i}" aria-label="Remove">×</button></span>`).join("")}
    <button type="button" class="link" data-wadd="${zoneId}" data-group="${group}">${list.length ? "+ add" : "Add times"}</button>
  </div>`;
}

function whatIfZone(z, e) {
  const temps = [];
  for (let t = 10; t <= 24; t += 0.5) temps.push(t);
  return `<div class="whatif-zone ${e.enabled ? "" : "off"}" data-zone-box="${z.local_id}">
    <div class="row">
      <label class="switch grow"><input type="checkbox" data-won="${z.local_id}" ${e.enabled ? "checked" : ""}> <strong>${esc(z.name)}</strong></label>
      ${z.has_sensors ? `<select data-wtemp="${z.local_id}" aria-label="${esc(z.name)} temperature" style="max-width:110px">${temps
        .map((t) => `<option value="${t}" ${t == e.temp ? "selected" : ""}>${t.toFixed(1)} °C</option>`).join("")}</select>` : `<span class="small muted">Hot water</span>`}
      <span class="small whatif-cost" data-wcost="${z.local_id}"></span>
    </div>
    ${e.enabled ? `${whatIfTimes(z.local_id, "weekday", e.weekday)}${whatIfTimes(z.local_id, "weekend", e.weekend)}
      ${e.simple || e.changed ? "" : `<p class="small muted">Its times differ from day to day; changing them here sets weekdays and weekends.</p>`}` : ""}
  </div>`;
}

function whatIfMonths(kit) {
  const start = new Date(kit.period.start + "T00:00:00");
  const end = new Date(new Date(kit.period.end + "T00:00:00") - 86400000);
  const fmt = (d) => d.toLocaleDateString([], { day: "numeric", month: "short" });
  const now = new Date();
  const options = [`<option value="current">This billing month (${fmt(start)} – ${fmt(end)})</option>`];
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    options.push(`<option value="${d.getFullYear()}-${d.getMonth()}">A typical ${MONTHS[d.getMonth()]}</option>`);
  }
  return options.join("");
}

async function whatIfCard(box, kit, budget, zones, rooms) {
  if (!kit) {
    box.innerHTML = `<h3>What if…</h3><p class="muted small">This appears once your controller has sent its first forecast, within the hour.</p>`;
    return;
  }
  const kz = kit.zones.filter((z) => z.slots.length || z.enabled);
  const base = currentSettings(kit);
  const edits = Object.fromEntries(kz.map((z) => [z.local_id, editableZone(z)]));
  let month = "current";

  const settings = () => {
    const out = currentSettings(kit);
    kz.forEach((z) => {
      const e = edits[z.local_id];
      out[z.local_id] = { enabled: e.enabled, slots: e.changed ? slotsFrom(e, z) : z.slots };
    });
    return out;
  };
  const price = (s) => {
    if (month == "current") return priceCurrent(kit, s);
    const [y, m] = month.split("-").map(Number);
    return priceTypicalMonth(kit, s, m, y);
  };

  // the dashboard and the controller should agree on today's settings
  const check = priceCurrent(kit, base);
  if (Math.abs(check.total_pence - kit.expected_pence) > Math.max(5, kit.expected_pence * 0.01)) {
    console.warn("What-if pricing differs from the controller's:", check.total_pence, kit.expected_pence);
  }

  box.innerHTML = `<h3>What if…</h3>
    <p class="small muted">Try other temperatures and warm times and see what the month would cost. It prices your settings as you set them, before the budget plan's automatic cuts.</p>
    <label for="whatif-month">Month</label>
    <select id="whatif-month" style="max-width:340px">${whatIfMonths(kit)}</select>
    <div id="whatif-result" class="whatif-result" aria-live="polite"></div>
    <div id="whatif-zones"></div>
    <div class="out"></div>
    <div class="row" style="margin-top:12px">
      <button class="primary" id="whatif-apply" disabled>Use these settings</button>
      <button id="whatif-reset" disabled>Reset</button>
    </div>
    <p class="small muted">Weather forecast for the next 16 days, then typical weather for your home. Figures from ${fmtAgo(kit.made_at)}.</p>`;

  const zonesBox = box.querySelector("#whatif-zones");
  const result = box.querySelector("#whatif-result");

  const update = () => {
    const now = price(settings());
    const before = price(base);
    const budgetPence = budget?.monthly_pence || null;
    const diff = now.total_pence - before.total_pence;
    const over = budgetPence ? now.total_pence - budgetPence : null;
    const pct = (v) => Math.min(100, Math.round((v / Math.max(budgetPence || 1, now.total_pence, 1)) * 100));
    result.innerHTML = `<div class="row"><span class="whatif-total">${pounds(now.total_pence)}</span>
        <span class="small muted grow">${month == "current" ? `for this billing month: ${pounds(now.spent_pence)} spent so far, ${pounds(now.total_pence - now.spent_pence)} to come` : `for a typical ${MONTHS[Number(month.split("-")[1])]} (${now.days} days)`}</span></div>
      ${budgetPence ? `<div class="bar" role="img" aria-label="${pounds(now.total_pence)} against a budget of ${pounds(budgetPence)}">
        <span class="spent" style="width:${pct(Math.min(now.total_pence, budgetPence))}%"></span></div>
        ${message(over > 0 ? "error" : "success", over > 0 ? `${pounds(over)} over your ${pounds(budgetPence)} budget` : `${pounds(-over)} under your ${pounds(budgetPence)} budget`)}` : ""}
      ${Math.abs(diff) >= 1 ? `<p class="small"><strong>${diff > 0 ? "+" : "−"}${pounds(Math.abs(diff))}</strong> compared with your current settings.</p>` : ""}
      <p class="small muted">Standing charge ${pounds(now.standing_pence)}${now.other_pence >= 1 ? `, other gas ${pounds(now.other_pence)}` : ""}.</p>`;
    kz.forEach((z) => {
      const cell = box.querySelector(`[data-wcost="${z.local_id}"]`);
      if (!cell) return;
      const a = now.zones[z.local_id] || 0;
      const b = before.zones[z.local_id] || 0;
      cell.innerHTML = `${pounds(a)}${Math.abs(a - b) >= 1 ? ` <span class="${a > b ? "worse" : "better"}">(${a > b ? "+" : "−"}${pounds(Math.abs(a - b))})</span>` : ""}`;
    });
    const dirty = kz.some((z) => edits[z.local_id].changed || edits[z.local_id].enabled != z.enabled);
    box.querySelector("#whatif-apply").disabled = !dirty;
    box.querySelector("#whatif-reset").disabled = !dirty;
  };

  const draw = () => {
    zonesBox.innerHTML = kz.map((z) => whatIfZone(z, edits[z.local_id])).join("");
    const touched = (id) => (edits[id].changed = true);
    zonesBox.querySelectorAll("[data-won]").forEach((c) => (c.onchange = () => { edits[c.dataset.won].enabled = c.checked; draw(); }));
    zonesBox.querySelectorAll("[data-wtemp]").forEach((sel) => (sel.onchange = () => {
      edits[sel.dataset.wtemp].temp = Number(sel.value);
      touched(sel.dataset.wtemp);
      update();
    }));
    zonesBox.querySelectorAll("[data-wz]").forEach((input) => (input.onchange = () => {
      const e = edits[input.dataset.wz];
      if (!input.value) return;
      e[input.dataset.group][Number(input.dataset.i)][Number(input.dataset.end)] = input.value;
      touched(input.dataset.wz);
      update();
    }));
    zonesBox.querySelectorAll("[data-wremove]").forEach((b) => (b.onclick = () => {
      edits[b.dataset.wremove][b.dataset.group].splice(Number(b.dataset.i), 1);
      touched(b.dataset.wremove);
      draw();
    }));
    zonesBox.querySelectorAll("[data-wadd]").forEach((b) => (b.onclick = () => {
      const list = edits[b.dataset.wadd][b.dataset.group];
      list.push(list.length ? [list[list.length - 1][1] < "21:00" ? "21:00" : "18:00", "22:00"] : ["07:00", "09:00"]);
      touched(b.dataset.wadd);
      draw();
    }));
    update();
  };

  box.querySelector("#whatif-month").onchange = (e) => { month = e.target.value; update(); };
  box.querySelector("#whatif-reset").onclick = () => {
    kz.forEach((z) => (edits[z.local_id] = editableZone(z)));
    draw();
  };
  box.querySelector("#whatif-apply").onclick = async (e) => {
    const out = box.querySelector(".out");
    const byLocal = Object.fromEntries(zones.map((z) => [z.local_id, z]));
    const changes = kz.filter((z) => edits[z.local_id].changed || edits[z.local_id].enabled != z.enabled);
    // intelligent zones take their times from their rooms: say which rooms change
    const roomNote = changes.filter((z) => z.intelligent && edits[z.local_id].changed && edits[z.local_id].enabled).map((z) => {
      const own = rooms.filter((r) => r.zone_id == byLocal[z.local_id]?.id);
      return own.length ? `${z.name}: sets the times of ${own.map((r) => r.name).join(", ")}` : "";
    }).filter(Boolean);
    if (!confirm(`Use these settings for ${changes.map((z) => z.name).join(", ")}?${roomNote.length ? "\n\n" + roomNote.join("\n") : ""}`)) return;
    e.target.disabled = true;
    try {
      for (const z of changes) {
        const ed = edits[z.local_id];
        const zone = byLocal[z.local_id];
        if (!zone) continue;
        if (ed.enabled != z.enabled) {
          const { error } = await supabase.from("zones").update({ is_enabled: ed.enabled }).eq("id", zone.id);
          if (error) throw error;
        }
        if (!ed.changed || !ed.enabled) continue;
        const own = rooms.filter((r) => r.zone_id == zone.id);
        if (z.intelligent && own.length) {
          // the temperature is the zone's comfort temperature; the times go to its rooms
          const { error } = await supabase.from("zones").update({ comfort_temp: ed.temp }).eq("id", zone.id);
          if (error) throw error;
          const periods = [
            ...ed.weekday.filter(([a, b]) => b > a).map(([from, to]) => ({ days: WEEK, from, to })),
            ...ed.weekend.filter(([a, b]) => b > a).map(([from, to]) => ({ days: WEEKEND, from, to })),
          ];
          for (const r of own) {
            const { error: roomError } = await supabase.from("rooms").update({ periods }).eq("id", r.id);
            if (roomError) throw roomError;
          }
        } else {
          if (z.intelligent) {
            const { error } = await supabase.from("zones").update({ comfort_temp: ed.temp }).eq("id", zone.id);
            if (error) throw error;
          }
          const { error } = await supabase.rpc("set_zone_schedule", {
            p_zone: zone.id,
            p_slots: slotsFrom(ed, z).map((s) => ({ day: s.day, on_time: s.from, off_time: s.to, temp: s.temp })),
          });
          if (error) throw error;
        }
      }
      out.innerHTML = message("success", "Saved. The controller picks them up within a minute, and the budget plan and this forecast update within the hour.");
    } catch (error) {
      out.innerHTML = message("error", fail(error));
      e.target.disabled = false;
    }
  };

  draw();
}

async function budgetPage() {
  setNav("budget");
  clearInterval(refreshTimer);
  const [{ budget, plan }, { data: zones }, { data: status }, controller, { data: acc }, { data: whatIf }, { data: rooms }] = await Promise.all([
    loadBudget(),
    supabase.from("zones").select("id, local_id, name, min_temp, budget_offset").eq("home_id", home.id).order("local_id"),
    supabase.from("energy_status").select("*").eq("home_id", home.id).maybeSingle(),
    loadController(),
    supabase.from("model_accuracy").select("summary").eq("home_id", home.id).maybeSingle(),
    supabase.from("what_if").select("kit").eq("home_id", home.id).maybeSingle(),
    supabase.from("rooms").select("id, name, zone_id").eq("home_id", home.id).order("name"),
  ]);
  showOfflineBanner(controller);
  const periodStart = plan?.period_start;
  const { data: daily } = periodStart
    ? await supabase.from("energy_daily").select("day, kwh, cost_pence, metered").eq("home_id", home.id).gte("day", periodStart).order("day")
    : { data: [] };
  const zoneByLocal = Object.fromEntries(zones.map((z) => [z.local_id, z]));
  if (plan) {
    // hide suggestions already applied or declined, and any the schedule has
    // already caught up with (the plan can be up to an hour old)
    const handled = budget?.declined_suggestions || [];
    const zoneIds = [...new Set(plan.suggestions.map((s) => zoneByLocal[s.zone_local_id]?.id).filter(Boolean))];
    const { data: slots } = zoneIds.length
      ? await supabase.from("schedule_slots").select("zone_id, on_time, off_time").in("zone_id", zoneIds)
      : { data: [] };
    const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const scheduled = (list, on, off) => list.reduce((sum, x) => sum + minutes(x[off]) - minutes(x[on]), 0);
    plan.suggestions = plan.suggestions.filter((s) => {
      if (handled.includes(s.key)) return false;
      const zone = zoneByLocal[s.zone_local_id];
      const now = scheduled(slots.filter((x) => x.zone_id == zone?.id), "on_time", "off_time");
      return now > scheduled(s.schedule, "onTime", "offTime");
    });
  }

  render(`<h1>Budget</h1>
    ${budgetCard(budget, plan, false)}
    ${plan ? `<section class="card">
      <h3>The plan</h3>
      <p><button id="explain">Explain my plan</button></p>
      <div id="explanation"></div>
      ${plan.automatic.length ? `<p class="small muted">Changes made automatically:</p><ul>${plan.automatic.map((a) => `<li>${esc(a.text)}</li>`).join("")}</ul>`
        : `<p class="muted">No changes needed at the moment.</p>`}
      ${plan.suggestions.length ? `<p class="small muted">Suggestions${plan.forecast_pence > plan.budget_pence ? ", needed to stay within budget" : ""}:</p>
        ${plan.suggestions.map((s) => `<div class="row suggestion">
          <span class="grow">${esc(s.text)} <span class="small muted">Saves about ${pounds(s.saving_pence)} this month.</span></span>
          <button class="primary" data-apply="${esc(s.key)}">Apply</button><button data-decline="${esc(s.key)}">Not now</button></div>`).join("")}` : ""}
      ${plan.trv_advice.length ? `<p class="small muted">Radiator valves:</p><ul>${plan.trv_advice.map((t) => `<li>${esc(t.text)}</li>`).join("")}</ul>` : ""}
    </section>` : ""}
    <section class="card" id="what-if"></section>
    ${daily.length ? `<section class="card"><h3>Daily cost this month</h3>
      <div class="chart-wrap short"><canvas id="costs" role="img" aria-label="Gas cost each day this billing month"></canvas></div>
      <p class="small muted">Striped bars are estimated from boiler time; solid bars are from your meter.</p></section>` : ""}
    ${accuracyCard(acc?.summary, zones)}
    <section class="card">
      <h3>Ask about your heating</h3>
      ${chatBox("ask", "e.g. Why is this month more expensive?")}
    </section>
    <section class="card">
      <h3>Budget settings</h3>
      <form id="budget">
        <div class="row">
          <label class="grow">Monthly budget (£)<input name="pounds" type="number" min="1" step="1" value="${budget ? Math.round(budget.monthly_pence / 100) : ""}" required></label>
          <label class="grow">Billing day<input name="day" type="number" min="1" max="28" value="${budget?.start_day ?? 1}" required></label>
          <label class="grow">Boiler size (kW)<input name="kw" type="number" min="4" max="60" step="0.5" value="${budget?.boiler_kw ?? 24}" required></label>
        </div>
        <label class="switch"><input type="checkbox" name="other" ${budget?.other_gas === false ? "" : "checked"}> We also use gas for cooking or other appliances (such as a gas fire)</label>
        <p class="small muted">Untick if gas is only used for heating and hot water, so all of it is put down to those.</p>
        <p class="small muted">The lowest each zone may go to stay within budget:</p>
        ${zones.map((z) => `<div class="row"><span class="grow">${esc(z.name)}</span>
          <select data-min="${z.id}" aria-label="Minimum for ${esc(z.name)}">${[5, 10, 12, 14, 15, 16, 17, 18, 19, 20].map((t) =>
            `<option value="${t}" ${Number(z.min_temp) == t ? "selected" : ""}>${t == 5 ? "Frost only" : t + " °C"}</option>`).join("")}</select></div>`).join("")}
        <div class="out"></div>
        <button class="primary" type="submit">Save</button>
        <p class="small muted">Tell us <a href="#/rooms">which rooms you use and when</a> and the plan can cool the right places.</p>
      </form>
    </section>
    <section class="card">
      <h3>Octopus Energy</h3>
      ${status?.connected ? `<p>Connected. ${esc(status.tariff_code || "")}: ${Number(status.unit_rate_pence).toFixed(2)}p per kWh, ${Number(status.standing_pence).toFixed(2)}p a day.
          Latest meter reading ${fmtAgo(status.last_reading_at)}. Your meter reports in ${status.meter_unit == "m3" ? "cubic metres" : "kWh"}.</p>`
        : `<p class="small muted">${status?.error ? esc(status.error) + ". " : ""}Until Octopus is connected, costs are estimated from boiler time and the Ofgem price cap.</p>`}
      <form id="octopus">
        <div class="row">
          <label class="grow">Account number<input name="account" placeholder="A-1234ABCD" autocomplete="off" required></label>
          <label class="grow">API key<input name="key" type="password" autocomplete="off" placeholder="${status?.connected ? "unchanged" : "sk_live_…"}"></label>
          <label class="grow">Meter units<select name="unit"><option value="">Detect</option><option value="kWh">kWh</option><option value="m3">Cubic metres</option></select></label>
        </div>
        <p class="small muted">Find both on your Octopus account page under "API access". The key is stored only on your controller.</p>
        <div class="out"></div>
        <button type="submit">Connect</button>
      </form>
    </section>`);

  if (daily.length) drawCosts(daily);
  bindChat("ask", "ask");
  whatIfCard(document.getElementById("what-if"), whatIf?.kit || null, budget, zones, rooms || []);
  document.getElementById("try-changes")?.addEventListener("click", () => document.getElementById("what-if").scrollIntoView({ behavior: "smooth" }));

  document.getElementById("explain")?.addEventListener("click", async (e) => {
    const out = document.getElementById("explanation");
    e.target.disabled = true;
    out.innerHTML = message("info", "Thinking…");
    try {
      out.innerHTML = `<p class="assistant-note">${esc((await askAssistant("explain", [])).reply).replace(/\n+/g, "<br><br>")}</p>`;
    } catch (error) {
      out.innerHTML = message("error", fail(error));
    }
    e.target.disabled = false;
  });

  app.querySelectorAll("[data-apply]").forEach((b) => {
    b.onclick = async () => {
      const s = plan.suggestions.find((x) => x.key == b.dataset.apply);
      const zone = zoneByLocal[s.zone_local_id];
      if (!confirm(`${s.text}\n\nThis changes the ${zone.name} schedule. Apply?`)) return;
      b.disabled = true;
      const { error } = await supabase.rpc("set_zone_schedule", {
        p_zone: zone.id,
        p_slots: s.schedule.map((x) => ({ day: x.day, on_time: x.onTime.slice(0, 5), off_time: x.offTime.slice(0, 5), temp: x.temp })),
      });
      if (error) return alert(fail(error));
      // remember it, so it isn't shown or suggested again this month
      const handled = (budget.declined_suggestions || []).concat(s.key);
      await supabase.from("budgets").update({ declined_suggestions: handled }).eq("home_id", home.id);
      budget.declined_suggestions = handled;
      b.closest(".suggestion").innerHTML = message("success", "Applied. The plan updates within the hour.");
    };
  });
  app.querySelectorAll("[data-decline]").forEach((b) => {
    b.onclick = async () => {
      const declined = (budget.declined_suggestions || []).concat(b.dataset.decline);
      const { error } = await supabase.from("budgets").update({ declined_suggestions: declined }).eq("home_id", home.id);
      if (error) return alert(fail(error));
      budget.declined_suggestions = declined;
      b.closest(".suggestion").remove();
    };
  });

  const form = document.getElementById("budget");
  form.onsubmit = (e) => {
    e.preventDefault();
    submitting(form, async (out) => {
      const fields = {
        home_id: home.id,
        monthly_pence: Math.round(Number(form.pounds.value) * 100),
        start_day: Number(form.day.value),
        boiler_kw: Number(form.kw.value),
        other_gas: form.other.checked,
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabase.from("budgets").upsert(fields);
      if (error) throw error;
      for (const sel of form.querySelectorAll("[data-min]")) {
        const { error: e2 } = await supabase.from("zones").update({ min_temp: Number(sel.value) }).eq("id", sel.dataset.min);
        if (e2) throw e2;
      }
      out.innerHTML = message("success", "Saved. Your controller makes a new plan within the hour.");
    });
  };

  const oct = document.getElementById("octopus");
  oct.onsubmit = (e) => {
    e.preventDefault();
    submitting(oct, async (out) => {
      out.innerHTML = message("info", "Checking with Octopus through your controller…");
      const payload = { account: oct.account.value.trim(), unit: oct.unit.value || null };
      if (oct.key.value.trim()) payload.api_key = oct.key.value.trim();
      const result = await runCommand("set_octopus", payload, 90000);
      if (result.error) throw new Error(result.error);
      oct.key.value = "";
      out.innerHTML = message("success", `Connected (${result.tariff}). Readings and costs appear within the hour.`);
    });
  };
}

// How well the controller's predictions have matched reality lately
function accuracyCard(a, zones) {
  if (!a) return "";
  const s = a.summary || {};
  const zoneName = Object.fromEntries(zones.map((z) => [String(z.local_id), z.name]));
  const lines = [];
  if (s.gas_kwh_day) lines.push(`Daily gas forecasts: within ${s.gas_kwh_day.meanPercentError ?? "–"}% on average over ${s.gas_kwh_day.n} days, ` +
    `${s.gas_kwh_day.bias > 0 ? "a little high" : s.gas_kwh_day.bias < 0 ? "a little low" : "unbiased"} (${s.gas_kwh_day.bias > 0 ? "+" : ""}${s.gas_kwh_day.bias} kWh).`);
  if (s.room_temp_60) lines.push(`Room temperatures an hour ahead: within ${s.room_temp_60.meanError} °C on average (${s.room_temp_60.n} checks).`);
  if (s.room_peak_2h) lines.push(`Warmth after an early switch-off: within ${s.room_peak_2h.meanError} °C (${s.room_peak_2h.n} checks).`);
  if (s.outdoor_mean_day) lines.push(`Weather forecasts: within ${s.outdoor_mean_day.meanError} °C a day (${s.outdoor_mean_day.n} days).`);
  if (s.month_cost) lines.push(`Month-end forecasts: within ${(s.month_cost.meanError / 100).toFixed(2)} pounds (${s.month_cost.n} forecasts).`);
  if (s.zone_hours_day_sim) lines.push(`Heating hours from running intelligent zones' controllers ahead: within ${s.zone_hours_day_sim.meanPercentError ?? "–"}% on average (${s.zone_hours_day_sim.n} zone-days). ` +
    `A zone's forecast switches to this once it's within 20% over two weeks.`);
  const corrections = [];
  if (a.gasFactor && a.gasFactor != 1) corrections.push(`gas forecasts are scaled by ${a.gasFactor} to match your meter`);
  Object.entries(a.kScale || {}).forEach(([z, k]) => {
    if (k != 1) corrections.push(`${zoneName[z] || "zone " + z} cools ${k > 1 ? "faster" : "slower"} than first learned (×${k})`);
  });
  return `<section class="card"><h3>How accurate the forecasts are</h3>
    ${lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : `<p class="muted">Still collecting: forecasts are checked against your meter and sensors as each day passes.</p>`}
    ${corrections.length ? `<p class="small muted">Corrections in use: ${esc(corrections.join("; "))}.</p>` : ""}
    <p class="small muted">Every forecast is kept and checked, and the corrections update each night.</p>
  </section>`;
}

let costChart = null;

function drawCosts(daily) {
  if (costChart) costChart.destroy();
  const style = getComputedStyle(document.documentElement);
  const muted = style.getPropertyValue("--muted").trim();
  const grid = style.getPropertyValue("--border").trim();
  costChart = new Chart(document.getElementById("costs"), {
    type: "bar",
    data: {
      labels: daily.map((d) => new Date(d.day).toLocaleDateString([], { day: "numeric", month: "short" })),
      datasets: [{
        label: "Cost",
        data: daily.map((d) => d.cost_pence / 100),
        backgroundColor: daily.map((d) => (d.metered ? SERIES[0] : chartPattern(SERIES[0] + "99", "diagonal"))),
        borderRadius: 4,
        maxBarThickness: 18,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (item) => {
          const d = daily[item.dataIndex];
          return `£${(d.cost_pence / 100).toFixed(2)}, ${Number(d.kwh).toFixed(1)} kWh${d.metered ? "" : " (estimated)"}`;
        } } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12 } },
        y: { grid: { color: grid }, beginAtZero: true, ticks: { color: muted, callback: (v) => "£" + v } },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Costs: each month's gas bill split by what it paid for

// colour and pattern per category, fixed so each keeps its look every month
const COST_STYLES = {
  standing: { color: "#898781", pattern: "solid" },
  hot_water: { color: "#d55e00", pattern: "vertical" },
  other: { color: "#56b4e9", pattern: "back-diagonal" },
};
const ZONE_STYLES = [
  { color: "#0072b2", pattern: "diagonal" },
  { color: "#e69f00", pattern: "dots" },
  { color: "#009e73", pattern: "cross" },
  { color: "#cc79a7", pattern: "horizontal" },
];

function costStyle(item) {
  if (item.key == "zone") return ZONE_STYLES[(((item.zone_local_id - 1) % ZONE_STYLES.length) + ZONE_STYLES.length) % ZONE_STYLES.length];
  return COST_STYLES[item.key];
}

function costColor(item) {
  return costStyle(item).color;
}

function periodLabel(p, long) {
  const start = new Date(p.period_start);
  const end = new Date(new Date(p.period_end) - 86400000);
  const opts = long ? { day: "numeric", month: "short" } : { month: "short" };
  return long ? `${start.toLocaleDateString([], opts)} – ${end.toLocaleDateString([], opts)}` : start.toLocaleDateString([], { month: "short", year: "2-digit" });
}

let costsChart = null;

async function costsPage() {
  setNav("costs");
  clearInterval(refreshTimer);
  const { data: periods, error } = await supabase.from("cost_breakdowns").select("*").eq("home_id", home.id).order("period_start");
  if (error) return render(message("error", fail(error)));
  if (!periods.length) {
    return render(`<h1>Costs</h1><section class="card"><p class="muted">Costs appear here once your controller has gas readings or heating history. Connect Octopus on the Budget page for exact figures.</p></section>`);
  }
  const current = periods.find((p) => p.is_current) || periods[periods.length - 1];

  render(`<h1>Costs</h1>
    <section class="card">
      <h3>Gas each month</h3>
      <div class="chart-wrap"><canvas id="months" role="img" aria-label="Gas cost each billing month, split by standing charge, each zone, hot water and other gas"></canvas></div>
      <p class="small muted">Click a month for its breakdown. The paler block on the current month is the projection for the rest of it.</p>
    </section>
    <section class="card" id="month"></section>
    <p class="small muted">The meter only measures the whole house, so the split between zones is estimated from how long each heated and how much gas an hour of heating uses there. The parts always add up to the metered total.</p>`);

  showMonth(current);
  drawMonths(periods, (p) => showMonth(p));
}

function showMonth(p) {
  const box = document.getElementById("month");
  const total = p.actual_pence + p.projected_pence;
  const current = p.is_current;
  box.innerHTML = `<h3>${periodLabel(p, true)}${current ? " (this month)" : ""}</h3>
    <p>${current
      ? `<strong>${pounds(p.actual_pence)}</strong> so far, heading for about <strong>${pounds(total)}</strong> by the end of the month.`
      : `<strong>${pounds(p.actual_pence)}</strong> in total.`}
      ${p.estimated_days ? `<span class="small muted">${p.estimated_days} day${p.estimated_days == 1 ? " is" : "s are"} estimated from boiler time.</span>` : ""}</p>
    <table>
      <thead><tr><th>For</th>${current ? `<th class="num">So far</th><th class="num hide-small">Rest of month</th>` : ""}<th class="num">${current ? "Month" : "Cost"}</th><th class="num hide-small">Share</th></tr></thead>
      <tbody>${p.items.map((i) => {
        const t = i.actual_pence + i.projected_pence;
        const st = costStyle(i);
        return `<tr><td><span class="swatch" style="${swatchStyle(st.color, st.pattern)}"></span>${esc(i.name)}</td>
          ${current ? `<td class="num">${pounds(i.actual_pence)}</td><td class="num hide-small">${pounds(i.projected_pence)}</td>` : ""}
          <td class="num"><strong>${pounds(t)}</strong></td><td class="num hide-small">${total ? Math.round((t / total) * 100) : 0}%</td></tr>`;
      }).join("")}
      <tr class="total"><td>Total</td>${current ? `<td class="num">${pounds(p.actual_pence)}</td><td class="num hide-small">${pounds(p.projected_pence)}</td>` : ""}<td class="num"><strong>${pounds(total)}</strong></td><td class="hide-small"></td></tr>
      </tbody>
    </table>`;
}

function drawMonths(periods, onPick) {
  if (costsChart) costsChart.destroy();
  const style = getComputedStyle(document.documentElement);
  const muted = style.getPropertyValue("--muted").trim();
  const grid = style.getPropertyValue("--border").trim();

  // one dataset per category, in a fixed order, so colours follow the category
  const keys = [];
  periods.forEach((p) => p.items.forEach((i) => {
    const id = i.key + ":" + (i.zone_local_id ?? "");
    if (!keys.some((k) => k.id == id)) keys.push({ id, item: i });
  }));
  const order = { standing: 0, zone: 1, hot_water: 2, other: 3 };
  keys.sort((a, b) => order[a.item.key] - order[b.item.key] || (a.item.zone_local_id || 0) - (b.item.zone_local_id || 0));

  const datasets = keys.map((k) => ({
    label: k.item.name,
    data: periods.map((p) => {
      const i = p.items.find((x) => x.key + ":" + (x.zone_local_id ?? "") == k.id);
      return i ? i.actual_pence / 100 : 0;
    }),
    backgroundColor: chartPattern(costStyle(k.item).color, costStyle(k.item).pattern),
    borderColor: style.getPropertyValue("--surface").trim() || "#fff",
    borderWidth: { top: 2 },
    maxBarThickness: 28,
    stack: "cost",
  }));
  datasets.push({
    label: "Projected rest of month",
    data: periods.map((p) => (p.is_current ? p.projected_pence / 100 : 0)),
    backgroundColor: "rgba(137, 135, 129, 0.25)",
    borderColor: "#898781",
    borderWidth: 1,
    borderDash: [4, 3],
    maxBarThickness: 28,
    stack: "cost",
  });

  costsChart = new Chart(document.getElementById("months"), {
    type: "bar",
    data: { labels: periods.map((p) => periodLabel(p) + (p.is_current ? "*" : "")), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      onClick: (e, elements) => {
        if (elements.length) onPick(periods[elements[0].index]);
      },
      plugins: {
        legend: { position: "bottom", labels: { color: muted, boxWidth: 10, boxHeight: 10 } },
        tooltip: {
          filter: (item) => item.parsed.y > 0,
          callbacks: {
            label: (item) => `${item.dataset.label}: £${item.parsed.y.toFixed(2)}`,
            footer: (items) => {
              const p = periods[items[0].dataIndex];
              return `Total £${((p.actual_pence + p.projected_pence) / 100).toFixed(2)}`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: muted } },
        y: { stacked: true, grid: { color: grid }, ticks: { color: muted, callback: (v) => "£" + v } },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Rooms: which rooms are in each zone and when they're used

// Common times for the manual room form
const WEEK = [1, 2, 3, 4, 5];
const ALL = [0, 1, 2, 3, 4, 5, 6];
const USE_TIMES = {
  "Any time": [],
  "Evenings": [{ days: ALL, from: "17:00", to: "23:00" }],
  "Mornings and evenings": [{ days: ALL, from: "06:30", to: "09:00" }, { days: ALL, from: "17:00", to: "23:00" }],
  "Nights": [{ days: ALL, from: "21:00", to: "23:30" }, { days: ALL, from: "06:00", to: "08:00" }],
  "Weekday working hours": [{ days: WEEK, from: "08:30", to: "17:30" }],
  "Weekends": [{ days: [0, 6], from: "08:00", to: "23:00" }],
};

function describePeriods(periods) {
  if (!periods?.length) return "Any time";
  return periods.map((p) => {
    const days = [...p.days].sort().join(",");
    const label = days == "1,2,3,4,5" ? "Weekdays" : days == "0,6" ? "Weekends" : days == "0,1,2,3,4,5,6" ? "Every day" : p.days.map((d) => DAY_NAMES[d]).join(" ");
    return `${label} ${p.from}–${p.to}`;
  }).join("; ");
}

const USAGE_LABEL = { often: "Used often", sometimes: "Used sometimes", rarely: "Rarely used" };
const DAY_CHOICES = [["0,1,2,3,4,5,6", "Every day"], ["1,2,3,4,5", "Weekdays"], ["0,6", "Weekends"],
  ...[1, 2, 3, 4, 5, 6, 0].map((d) => [String(d), DAYS[d]])];

// What a room's times mean for the heating, in words
function roomTimesText(room) {
  if (room.periods?.length) return describePeriods(room.periods);
  return room.usage == "rarely" ? "No set times: kept at the zone's minimum" : "No set times: follows the zone's schedule";
}

// The times editor for one room: rows of days, from and to
function periodRows(periods) {
  return periods.map((p, i) => {
    const key = [...p.days].sort().join(",");
    const known = DAY_CHOICES.some(([v]) => v == key);
    const options = (known ? DAY_CHOICES : [[key, describePeriods([{ days: p.days, from: "", to: "" }]).trim()], ...DAY_CHOICES])
      .map(([v, label]) => `<option value="${v}" ${v == key ? "selected" : ""}>${esc(label)}</option>`).join("");
    return `<div class="row period" data-i="${i}">
      <select class="grow" data-f="days" aria-label="Days">${options}</select>
      <input type="time" data-f="from" value="${p.from}" aria-label="From" required style="max-width:120px">
      <span>to</span>
      <input type="time" data-f="to" value="${p.to}" aria-label="To" required style="max-width:120px">
      <button type="button" class="link danger" data-remove-period="${i}" aria-label="Remove these times">Remove</button>
    </div>`;
  }).join("");
}

function roomForm(room, zones) {
  return `<form class="room-form" data-room-form="${room.id || "new"}">
    <div class="row">
      <label class="grow">Room<input name="name" value="${esc(room.name || "")}" maxlength="40" required></label>
      <label class="grow">Zone<select name="zone">${zones.map((z) => `<option value="${z.id}" ${z.id == room.zone_id ? "selected" : ""}>${esc(z.name)}</option>`).join("")}</select></label>
      <label class="grow">How often<select name="usage">${Object.entries(USAGE_LABEL)
        .map(([v, label]) => `<option value="${v}" ${v == room.usage ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    </div>
    <label>When it's used</label>
    <div class="periods">${periodRows(room.periods || [])}</div>
    <p class="small muted no-times" ${room.periods?.length ? "hidden" : ""}>No set times. Used often or sometimes: warm during the zone's schedule. Rarely used: kept at the zone's minimum.</p>
    <div class="row"><button type="button" class="link" data-add-period>Add times</button></div>
    <label class="switch" style="margin-top:12px"><input type="checkbox" name="trv" ${room.has_trv === false ? "" : "checked"}> Has a radiator valve (TRV)</label>
    <div class="out"></div>
    <div class="row" style="margin-top:12px"><button class="primary" type="submit">Save</button><button type="button" data-cancel>Cancel</button></div>
  </form>`;
}

function readPeriods(form) {
  return [...form.querySelectorAll(".period")].map((row) => ({
    days: row.querySelector("[data-f=days]").value.split(",").map(Number),
    from: row.querySelector("[data-f=from]").value,
    to: row.querySelector("[data-f=to]").value,
  }));
}

function bindRoomForm(form, room, onDone) {
  const periodsBox = form.querySelector(".periods");
  const redraw = (periods) => {
    periodsBox.innerHTML = periodRows(periods);
    form.querySelector(".no-times").hidden = periods.length > 0;
    periodsBox.querySelectorAll("[data-remove-period]").forEach((b) => {
      b.onclick = () => {
        const periods = readPeriods(form);
        periods.splice(Number(b.dataset.removePeriod), 1);
        redraw(periods);
      };
    });
  };
  redraw(room.periods || []);
  form.querySelector("[data-add-period]").onclick = () => redraw([...readPeriods(form), { days: ALL, from: "07:00", to: "22:00" }]);
  form.querySelector("[data-cancel]").onclick = onDone;
  form.onsubmit = (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const periods = readPeriods(form);
      if (periods.some((p) => p.to <= p.from)) throw new Error("Each time must end after it starts.");
      const fields = {
        name: form.querySelector("[name=name]").value.trim(),
        zone_id: form.zone.value,
        usage: form.usage.value,
        has_trv: form.trv.checked,
        periods,
      };
      const { error } = room.id
        ? await supabase.from("rooms").update(fields).eq("id", room.id)
        : await supabase.from("rooms").insert({ home_id: home.id, ...fields });
      if (error) throw error;
      onDone();
    });
  };
}

// Rooms: which rooms are in each zone and when they're used. With
// intelligent heating, these times decide when each zone is warm.
async function roomsPage() {
  setNav("rooms");
  clearInterval(refreshTimer);
  const [{ data: rooms }, { data: zones }, { data: sensors }] = await Promise.all([
    supabase.from("rooms").select("*").eq("home_id", home.id).order("name"),
    supabase.from("zones").select("id, local_id, name, eco_enabled, plan, min_temp").eq("home_id", home.id).order("local_id"),
    supabase.from("sensors").select("zone_id").eq("home_id", home.id),
  ]);
  const withSensor = new Set(sensors.map((s) => s.zone_id));
  const shown = zones.filter((z) => withSensor.has(z.id) || rooms.some((r) => r.zone_id == z.id));

  render(`<h1>Rooms</h1>
    <p class="muted">With intelligent heating on, each zone is warm when its rooms are used. Set the times here and the controller works out when to start the boiler.</p>
    ${shown.map((z) => {
      const own = rooms.filter((r) => r.zone_id == z.id);
      const intelligent = z.eco_enabled && withSensor.has(z.id);
      const warm = intelligent && z.plan?.slots?.length
        ? `<p class="small" style="margin-bottom:0">Warm:</p><ul class="small" style="margin-top:4px">${describeWarm(z.plan.slots)}</ul>`
        : intelligent ? `<p class="small muted">Working out the warm times…</p>`
        : `<p class="small muted">Intelligent heating is off for this zone, so it follows its schedule. <a href="#/zone/${z.id}">Switch it on</a> to heat by these room times.</p>`;
      return `<section class="card">
        <div class="zone-head"><h3>${esc(z.name)}</h3>${modePill(z, withSensor.has(z.id))}</div>
        ${warm}
        ${own.length ? `<ul class="rooms">${own.map((r) => `<li data-room-item="${r.id}">
            <div class="row"><strong class="grow">${esc(r.name)}</strong>
              <button class="link" data-edit-room="${r.id}">Edit</button>
              <button class="link danger" data-remove-room="${r.id}">Remove</button></div>
            <div class="small">${USAGE_LABEL[r.usage]} · ${esc(roomTimesText(r))}${r.has_trv ? "" : " · no radiator valve"}</div>
          </li>`).join("")}</ul>`
          : `<p class="muted small">No rooms yet.</p>`}
        <button class="link" data-add-room="${z.id}">Add a room</button>
      </section>`;
    }).join("")}
    <section class="card">
      <h3>Describe your home instead</h3>
      <p class="small muted">Tell the assistant about your rooms and when you use them; it suggests a list for you to check.</p>
      ${chatBox("home-chat", "e.g. Upstairs is two bedrooms and a study…")}
      <div id="proposal"></div>
    </section>`);

  bindChat("home-chat", "home", (proposal) => showProposal(proposal, zones));

  const openForm = (anchor, room) => {
    app.querySelectorAll(".room-form").forEach((f) => f.remove());
    anchor.insertAdjacentHTML("afterend", roomForm(room, shown)); // zones with a sensor (not hot water)
    const form = anchor.nextElementSibling;
    bindRoomForm(form, room, roomsPage);
    form.querySelector("[name=name]").focus();
  };
  app.querySelectorAll("[data-edit-room]").forEach((b) => {
    b.onclick = () => openForm(b.closest("li"), rooms.find((r) => r.id == b.dataset.editRoom));
  });
  app.querySelectorAll("[data-add-room]").forEach((b) => {
    b.onclick = () => openForm(b, { zone_id: b.dataset.addRoom, usage: "often", has_trv: true, periods: [{ days: ALL, from: "07:00", to: "22:00" }] });
  });
  app.querySelectorAll("[data-remove-room]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Remove this room?")) return;
      const { error } = await supabase.from("rooms").delete().eq("id", b.dataset.removeRoom);
      if (error) return alert(fail(error));
      roomsPage();
    };
  });
}

function showProposal(proposal, zones) {
  const byLocal = Object.fromEntries(zones.map((z) => [z.local_id, z]));
  const rooms = (proposal.rooms || []).filter((r) => byLocal[r.zone_local_id]);
  const box = document.getElementById("proposal");
  box.innerHTML = `<h3>Suggested rooms</h3>
    <table><thead><tr><th>Room</th><th>Zone</th><th>Use</th><th class="hide-small">Valve</th></tr></thead><tbody>
    ${rooms.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(byLocal[r.zone_local_id].name)}</td>
      <td>${esc(r.usage)}<div class="small muted">${esc(describePeriods(r.periods))}</div></td><td class="hide-small">${r.has_trv ? "Yes" : "No"}</td></tr>`).join("")}
    </tbody></table>
    <form class="row" id="save-rooms"><button class="primary" type="submit">Save these rooms</button>
      <span class="small muted">Replaces your current list.</span><div class="out" style="width:100%"></div></form>`;
  const form = document.getElementById("save-rooms");
  form.onsubmit = (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const { error: delError } = await supabase.from("rooms").delete().eq("home_id", home.id);
      if (delError) throw delError;
      const { error } = await supabase.from("rooms").insert(rooms.map((r) => ({
        home_id: home.id,
        zone_id: byLocal[r.zone_local_id].id,
        name: r.name.slice(0, 40),
        kind: r.kind,
        has_trv: r.has_trv,
        usage: r.usage,
        periods: r.periods,
      })));
      if (error) throw error;
      roomsPage();
    });
  };
}

// ---------------------------------------------------------------------------
// Routing

async function route_() {
  clearInterval(refreshTimer);
  const hash = location.hash || "#/";

  if (!session) {
    if (hash == "#/signup") return signUpPage();
    if (hash == "#/forgot") return forgotPage();
    return signInPage();
  }

  if (hash == "#/new-password") return newPasswordPage();

  try {
    if (!home) await loadHome();
  } catch (error) {
    return render(message("error", fail(error)));
  }
  if (!home || hash == "#/claim") return home && hash == "#/claim" ? go("#/") : await claimPage();

  try {
    if (hash.startsWith("#/zone/")) return await zonePage(hash.slice("#/zone/".length));
    if (hash == "#/sensors") return await sensorsPage();
    if (hash == "#/budget") return await budgetPage();
    if (hash == "#/costs") return await costsPage();
    if (hash == "#/rooms" || hash == "#/home") return await roomsPage();
    if (hash == "#/settings") return await settingsPage();
    return await zonesPage();
  } catch (error) {
    render(message("error", fail(error)));
  }
}

window.addEventListener("hashchange", route_);

supabase.auth.onAuthStateChange((event, newSession) => {
  const signedIn = !!newSession && !session;
  session = newSession;
  if (event == "PASSWORD_RECOVERY") return go("#/new-password");
  if (event == "SIGNED_OUT") {
    home = null;
    banner.hidden = true;
    return go("#/signin");
  }
  if (signedIn && ["#/signin", "#/signup", "#/forgot", ""].includes(location.hash)) return go("#/");
});

const { data } = await supabase.auth.getSession();
session = data.session;
route_();
