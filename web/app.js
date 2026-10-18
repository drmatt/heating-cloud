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
import { config } from "./config.js?v=2026101803";

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
const SERIES = ["#2a78d6", "#1baf7a", "#eda100", "#6250d6", "#e87ba4"];

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

function claimPage() {
  setNav(null);
  banner.hidden = true;
  render(`<div class="card narrow">
    <h1>Connect your controller</h1>
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

function zoneCard(zone) {
  const boosted = zone.boost_until && Date.parse(zone.boost_until) > Date.now();
  const status = zone.is_on
    ? `<span class="pill heat">${flame}Heating</span>`
    : `<span class="pill">Off</span>`;
  const lowered = Number(zone.budget_offset) > 0 ? ` <span class="pill">Budget −${Number(zone.budget_offset)}°</span>` : "";
  const target = zone.is_enabled && zone.desired_temp > 5 ? `<span class="muted small">Target ${fmtTemp(zone.desired_temp)}${lowered}</span>` : "";

  return `<article class="card zone ${zone.is_enabled ? "" : "disabled"}">
    <div class="zone-head">
      <a href="#/zone/${zone.id}">${esc(zone.name)}</a>
      ${status}
    </div>
    <div class="temp">${zone.current_temp == null ? `<small>No reading</small>` : fmtTemp(zone.current_temp)}</div>
    ${target}
    <div class="row">
      <label class="switch"><input type="checkbox" data-enable="${zone.id}" ${zone.is_enabled ? "checked" : ""}> Schedule on</label>
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

// Weather-adjusted energy figures. Before eco is switched on, fit
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
    text += ` For this weather you'd usually expect about ${e.expected.toFixed(1)} h, so eco saved an estimated
      <strong>${change > 0 ? change + "%" : "nothing yet"}</strong>.
      <span class="small muted">Based on ${e.baseDays} days before eco was switched on. An estimate, not a meter reading.</span>`;
  } else if (!e.ecoStart) {
    text += ` <span class="small muted">Switch on eco for a zone to start saving; savings show here once it has run for a few days.</span>`;
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
  const [{ data: zones, error }, controller, { data: notes }, { data: daily }, { data: sensors }, money] = await Promise.all([
    supabase.from("zones").select("*").eq("home_id", home.id).order("local_id"),
    loadController(),
    supabase.from("notifications").select("*").eq("home_id", home.id).is("dismissed_at", null)
      .gte("created_at", new Date(Date.now() - 21 * 86400000).toISOString()).order("created_at", { ascending: false }).limit(1),
    supabase.from("zone_daily").select("zone_local_id, day, boiler_minutes, eco_minutes, hdd").eq("home_id", home.id).gte("day", yearAgo).limit(5000),
    supabase.from("sensors").select("zone_id").eq("home_id", home.id),
    loadBudget(),
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
    <h1>Zones</h1>
    ${budgetCard(money.budget, money.plan, true)}
    <div class="zones">${zones.map(zoneCard).join("")}</div>
    ${energyCard(energySummary(daily || [], sensorZones))}`);

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

  render(`<p class="small"><a href="#/">← Zones</a></p>
    <h1>${esc(zone.name)}</h1>
    <section class="card">
      <h3>Last 24 hours</h3>
      ${ids.length ? `<div class="chart-wrap"><canvas id="chart" role="img" aria-label="Temperature in ${esc(zone.name)} over the last 24 hours, with times the heating was on"></canvas></div>`
        : `<p class="muted">No sensors in this zone. Add one on the <a href="#/sensors">Sensors</a> page.</p>`}
    </section>
    ${ids.length ? ecoSection(zone) : ""}
    ${daily.length ? `<section class="card">
      <h3>Heating time, last 30 days</h3>
      <div class="chart-wrap short"><canvas id="daily" role="img" aria-label="Hours of heating each day in ${esc(zone.name)} over the last 30 days"></canvas></div>
    </section>` : ""}
    <section class="card">
      <h3>Schedule</h3>
      <p class="small muted">The heating comes on in these periods when the room is below the temperature you set.</p>
      <form id="schedule">
        <div id="days"></div>
        <div class="out"></div>
        <div class="row"><button class="primary" type="submit">Save schedule</button>
          <button type="button" id="copy">Copy Monday to weekdays</button></div>
      </form>
    </section>`);

  if (ids.length) drawChart(sensors, readings, events, since);
  if (daily.length) drawDaily(daily);
  if (ids.length) bindEco(zone);
  scheduleEditor(zone, slots);
}

// What the controller has learned about the room, in plain words
function learnedText(model) {
  if (!model) return "Still learning how this room heats and cools. This takes a week or two of heating.";
  const parts = [];
  if (model.h) parts.push(`warms about ${Number(model.h).toFixed(1)} °C an hour with the heating on`);
  if (model.k) parts.push(`loses about ${(model.k * 15).toFixed(1)} °C an hour when it's 5 °C outside`);
  if (model.overshoot) parts.push(`keeps warming about ${Number(model.overshoot).toFixed(1)} °C after the boiler switches off`);
  let text = parts.length ? "This room " + parts.join(", ") + "." : "";
  if (!model.ready) text += " Still learning: eco uses the normal rules until it's confident.";
  else if (model.stale) text += " Learned last heating season.";
  return text;
}

function ecoSection(zone) {
  const margins = [0, 0.5, 1, 1.5, 2];
  return `<section class="card">
    <h3>Energy saving</h3>
    <label class="switch"><input type="checkbox" id="eco" ${zone.eco_enabled ? "checked" : ""}> Eco: learn this room and run the boiler less</label>
    <label for="margin">Let the room drift below the target by up to</label>
    <select id="margin" style="max-width:200px">${margins
      .map((m) => `<option value="${m}" ${Number(zone.comfort_margin) == m ? "selected" : ""}>${m == 0 ? "Never below target" : m + " °C"}</option>`)
      .join("")}</select>
    <p class="small muted">${esc(learnedText(zone.model))}</p>
    ${zone.is_enabled ? "" : `<p class="small muted">This zone is switched off. Its sensors check in once a day to save battery; press a sensor's button to wake it straight away.</p>`}
    <div class="out"></div>
  </section>`;
}

function bindEco(zone) {
  const save = async (fields) => {
    const { error } = await supabase.from("zones").update(fields).eq("id", zone.id);
    if (error) alert(fail(error));
  };
  document.getElementById("eco").onchange = (e) => save({ eco_enabled: e.target.checked });
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
    backgroundColor: heat + "33",
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

async function budgetPage() {
  setNav("budget");
  clearInterval(refreshTimer);
  const [{ budget, plan }, { data: zones }, { data: status }, controller] = await Promise.all([
    loadBudget(),
    supabase.from("zones").select("id, local_id, name, min_temp, budget_offset").eq("home_id", home.id).order("local_id"),
    supabase.from("energy_status").select("*").eq("home_id", home.id).maybeSingle(),
    loadController(),
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
    ${daily.length ? `<section class="card"><h3>Daily cost this month</h3>
      <div class="chart-wrap short"><canvas id="costs" role="img" aria-label="Gas cost each day this billing month"></canvas></div></section>` : ""}
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
        <p class="small muted">The lowest each zone may go to stay within budget:</p>
        ${zones.map((z) => `<div class="row"><span class="grow">${esc(z.name)}</span>
          <select data-min="${z.id}" aria-label="Minimum for ${esc(z.name)}">${[5, 10, 12, 14, 15, 16, 17, 18, 19, 20].map((t) =>
            `<option value="${t}" ${Number(z.min_temp) == t ? "selected" : ""}>${t == 5 ? "Frost only" : t + " °C"}</option>`).join("")}</select></div>`).join("")}
        <div class="out"></div>
        <button class="primary" type="submit">Save</button>
        <p class="small muted">Tell us <a href="#/home">which rooms you use and when</a> and the plan can cool the right places.</p>
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
        backgroundColor: daily.map((d) => (d.metered ? SERIES[0] : SERIES[0] + "66")),
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
// Your home: rooms and when they're used

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

async function homePage() {
  setNav("budget");
  clearInterval(refreshTimer);
  const [{ data: rooms }, { data: zones }] = await Promise.all([
    supabase.from("rooms").select("*").eq("home_id", home.id).order("name"),
    supabase.from("zones").select("id, local_id, name").eq("home_id", home.id).order("local_id"),
  ]);
  const zoneName = Object.fromEntries(zones.map((z) => [z.id, z.name]));
  const usageLabel = { often: "Used often", sometimes: "Used sometimes", rarely: "Rarely used" };

  render(`<p class="small"><a href="#/budget">← Budget</a></p>
    <h1>Your home</h1>
    <section class="card">
      <h3>Tell us about your rooms</h3>
      <p class="small muted">Which rooms are on each floor, and when you use them, so the budget plan cools the right places. The assistant asks a few questions and then suggests a list for you to check.</p>
      ${chatBox("home-chat", "e.g. Upstairs is two bedrooms and a study…")}
      <div id="proposal"></div>
    </section>
    <section class="card">
      <h3>Rooms</h3>
      ${rooms.length ? `<table><thead><tr><th>Room</th><th class="hide-small">Zone</th><th>Use</th><th class="hide-small">Valve</th><th></th></tr></thead><tbody>
        ${rooms.map((r) => `<tr><td>${esc(r.name)}</td><td class="hide-small">${esc(zoneName[r.zone_id] || "–")}</td>
          <td>${usageLabel[r.usage]}<div class="small muted">${esc(describePeriods(r.periods))}</div></td>
          <td class="hide-small">${r.has_trv ? "Yes" : "No"}</td>
          <td><button class="link danger" data-room="${r.id}">Remove</button></td></tr>`).join("")}</tbody></table>`
        : `<p class="muted">No rooms yet.</p>`}
      <form id="add-room" class="row" style="margin-top:12px">
        <input class="grow" name="name" placeholder="Room name" maxlength="40" required aria-label="Room name">
        <select class="grow" name="zone" aria-label="Zone">${zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join("")}</select>
        <select class="grow" name="usage" aria-label="How often it's used">
          <option value="often">Used often</option><option value="sometimes">Used sometimes</option><option value="rarely">Rarely used</option></select>
        <select class="grow" name="when" aria-label="When it's used">${Object.keys(USE_TIMES).map((k) => `<option value="${k}">${esc(k)}</option>`).join("")}</select>
        <label class="switch"><input type="checkbox" name="trv" checked> Radiator valve</label>
        <button type="submit">Add room</button>
        <div class="out" style="width:100%"></div>
      </form>
    </section>`);

  bindChat("home-chat", "home", (proposal) => showProposal(proposal, zones));

  const add = document.getElementById("add-room");
  add.onsubmit = (e) => {
    e.preventDefault();
    submitting(add, async () => {
      const { error } = await supabase.from("rooms").insert({
        home_id: home.id,
        zone_id: add.zone.value,
        name: add.querySelector("[name=name]").value.trim(),
        usage: add.usage.value,
        has_trv: add.trv.checked,
        periods: USE_TIMES[add.when.value],
      });
      if (error) throw error;
      homePage();
    });
  };
  app.querySelectorAll("[data-room]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Remove this room?")) return;
      const { error } = await supabase.from("rooms").delete().eq("id", b.dataset.room);
      if (error) return alert(fail(error));
      homePage();
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
      homePage();
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
  if (!home || hash == "#/claim") return home && hash == "#/claim" ? go("#/") : claimPage();

  try {
    if (hash.startsWith("#/zone/")) return await zonePage(hash.slice("#/zone/".length));
    if (hash == "#/sensors") return await sensorsPage();
    if (hash == "#/budget") return await budgetPage();
    if (hash == "#/home") return await homePage();
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
