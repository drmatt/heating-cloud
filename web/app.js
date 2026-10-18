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
import { config } from "./config.js";

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
  const target = zone.is_enabled && zone.desired_temp > 5 ? `<span class="muted small">Target ${fmtTemp(zone.desired_temp)}</span>` : "";

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

async function zonesPage() {
  setNav("zones");
  const [{ data: zones, error }, controller] = await Promise.all([
    supabase.from("zones").select("*").eq("home_id", home.id).order("local_id"),
    loadController(),
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

  render(`<h1>Zones</h1><div class="zones">${zones.map(zoneCard).join("")}</div>`);

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

  const [{ data: sensors }, { data: slots }, { data: events }] = await Promise.all([
    supabase.from("sensors").select("device_id, name").eq("zone_id", zoneId),
    supabase.from("schedule_slots").select("day, on_time, off_time, temp").eq("zone_id", zoneId).order("on_time"),
    supabase.from("zone_events").select("time, value").eq("home_id", home.id).eq("zone_local_id", zone.local_id)
      .eq("type", "BOILER").gte("time", since).order("time"),
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
  scheduleEditor(zone, slots);
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
  const controller = await loadController();
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
  document.getElementById("signout").onclick = () => supabase.auth.signOut();
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
