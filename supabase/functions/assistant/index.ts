// The heating assistant, powered by Claude.
//
// POST { mode, messages } with the customer's own access token:
//   mode "home"    - chat about the home's rooms and when they're used; when
//                    it knows enough it proposes rooms (returned as
//                    `proposal` for the customer to check and save)
//   mode "explain" - the current budget plan and radiator valve advice in
//                    plain words
//   mode "ask"     - answer a question about the heating, costs or plan
//
// It reads only the caller's own home, through row-level security, and never
// changes anything itself: proposals go back to the dashboard for approval.
// Needs the ANTHROPIC_API_KEY secret.

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MODEL = "claude-opus-5-5";
const DAILY_LIMIT = 40; // calls per home per day
const MAX_MESSAGES = 30;

type Mode = "home" | "explain" | "ask";
type ChatMessage = { role: "user" | "assistant"; content: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    },
  });
}

const proposeRooms: Anthropic.Tool = {
  name: "propose_rooms",
  description:
    "Propose the home's rooms, which heating zone each is in, and when each is used, for the owner to check and save. Call this once you know every room on every floor and roughly when each is used.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      rooms: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short room name, e.g. 'Spare bedroom'" },
            zone_local_id: { type: "integer", description: "local_id of the zone the room is in" },
            kind: { type: "string", enum: ["living", "kitchen", "bedroom", "spare", "office", "bathroom", "hall", "other"] },
            has_trv: { type: "boolean", description: "Whether its radiator has a thermostatic valve (TRV)" },
            usage: { type: "string", enum: ["often", "sometimes", "rarely"] },
            periods: {
              type: "array",
              description: "When the room is usually in use. Days are 0 = Sunday to 6 = Saturday; times are HH:MM, 24-hour.",
              items: {
                type: "object",
                properties: {
                  days: { type: "array", items: { type: "integer" } },
                  from: { type: "string" },
                  to: { type: "string" },
                },
                required: ["days", "from", "to"],
                additionalProperties: false,
              },
            },
          },
          required: ["name", "zone_local_id", "kind", "has_trv", "usage", "periods"],
          additionalProperties: false,
        },
      },
    },
    required: ["rooms"],
    additionalProperties: false,
  },
};

const GUIDE = `You are the assistant for a home heating controller sold to UK households. You help the owner keep warm within their monthly budget.
How the system works: the house is split into heating zones (usually floors), each with a temperature sensor, a schedule and a target. A planner on the controller keeps the month within budget by switching on "eco" (learned control that uses less boiler time), lowering targets in 0.5 °C steps (rarely used zones first, never below each zone's minimum temperature), and suggesting shorter heating periods or less hot water for the owner to approve. Rooms within a zone can only be controlled with their radiator valves (TRVs): about 1 = 12 °C, 2 = 15 °C, 3 = 18 °C, 4 = 21 °C, 5 = 24 °C, * = frost only.
Money is in pounds and pence. Figures marked estimated come from boiler time rather than the gas meter. Be warm, brief and practical; use plain words, short paragraphs, no jargon, no markdown headings. Never invent numbers that aren't in the data. You can't change settings yourself; say what the owner can do on the dashboard.`;

const MODE_GUIDE: Record<Mode, string> = {
  home: `Find out which rooms are in each zone and when each is used, so the planner can heat the right places. Ask one or two short questions at a time, starting with the zones you can see. Ask which radiators have valves. When you know every room and roughly when it's used, call propose_rooms, then say in a sentence what you've proposed.`,
  explain: `Explain the latest budget plan in a short note: how the month is going against the budget, what has been changed automatically and why, any suggestions waiting for approval, and the radiator valve advice. If there's no budget yet, say how to set one.`,
  ask: `Answer the owner's question using the data. If the answer depends on something not in the data, say so.`,
};

async function homeContext(db: ReturnType<typeof createClient>, homeId: string) {
  const since = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const [home, zones, slots, rooms, budget, plan, energy, status, daily] = await Promise.all([
    db.from("homes").select("name").eq("id", homeId).single(),
    db.from("zones").select("id, local_id, name, is_enabled, eco_enabled, comfort_margin, min_temp, budget_offset, current_temp, desired_temp, model").eq("home_id", homeId).order("local_id"),
    db.from("schedule_slots").select("zone_id, day, on_time, off_time, temp").eq("home_id", homeId),
    db.from("rooms").select("name, zone_id, kind, has_trv, usage, periods").eq("home_id", homeId),
    db.from("budgets").select("monthly_pence, start_day, boiler_kw").eq("home_id", homeId).maybeSingle(),
    db.from("budget_plans").select("*").eq("home_id", homeId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("energy_daily").select("day, kwh, cost_pence, metered").eq("home_id", homeId).gte("day", since).order("day"),
    db.from("energy_status").select("supplier, tariff_code, unit_rate_pence, standing_pence, connected, last_reading_at").eq("home_id", homeId).maybeSingle(),
    db.from("zone_daily").select("zone_local_id, day, boiler_minutes, mean_outdoor").eq("home_id", homeId).gte("day", since).order("day"),
  ]);
  const zoneById = Object.fromEntries((zones.data ?? []).map((z) => [z.id, z]));
  return {
    home: home.data?.name,
    today: new Date().toISOString().slice(0, 10),
    zones: (zones.data ?? []).map((z) => ({
      local_id: z.local_id,
      name: z.name,
      switched_on: z.is_enabled,
      eco: z.eco_enabled,
      minimum_temp: z.min_temp,
      budget_lowered_by: z.budget_offset,
      current_temp: z.current_temp,
      target_now: z.desired_temp,
      learned: z.model ? { heats_c_per_hour: z.model.h, overshoot_c: z.model.overshoot, ready: z.model.ready } : null,
      schedule: (slots.data ?? []).filter((s) => s.zone_id == z.id).map((s) => `${s.day}:${String(s.on_time).slice(0, 5)}-${String(s.off_time).slice(0, 5)}@${s.temp}`),
    })),
    rooms: (rooms.data ?? []).map((r) => ({ ...r, zone: zoneById[r.zone_id]?.name, zone_id: undefined })),
    budget: budget.data,
    latest_plan: plan.data,
    supply: status.data,
    daily_costs: energy.data,
    daily_heating_minutes: daily.data,
  };
}

Deno.serve(async (req) => {
  if (req.method == "OPTIONS") return json({});
  if (req.method != "POST") return json({ error: "Use POST" }, 405);

  let body: { mode?: Mode; messages?: ChatMessage[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send a JSON body" }, 400);
  }
  const mode: Mode = body.mode == "home" || body.mode == "explain" ? body.mode : "ask";
  const messages = (body.messages ?? [])
    .filter((m) => (m.role == "user" || m.role == "assistant") && typeof m.content == "string" && m.content.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (mode != "explain" && (!messages.length || messages[messages.length - 1].role != "user")) {
    return json({ error: "Send the conversation, ending with the owner's message" }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: user } = await caller.auth.getUser();
  if (!user?.user) return json({ error: "Sign in first" }, 401);

  const { data: membership } = await caller.from("home_members").select("home_id").eq("user_id", user.user.id).limit(1).maybeSingle();
  if (!membership) return json({ error: "Connect a controller first" }, 403);
  const homeId = membership.home_id;

  // a daily limit per home keeps costs predictable
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const today = new Date().toISOString().slice(0, 10);
  const { data: usage } = await admin.from("assistant_usage").select("calls").eq("home_id", homeId).eq("day", today).maybeSingle();
  if ((usage?.calls ?? 0) >= DAILY_LIMIT) return json({ error: "The assistant has reached today's limit. Try again tomorrow." }, 429);
  await admin.from("assistant_usage").upsert({ home_id: homeId, day: today, calls: (usage?.calls ?? 0) + 1 });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "The assistant isn't set up yet." }, 503);

  const context = await homeContext(caller, homeId);
  const anthropic = new Anthropic({ apiKey });

  const conversation: Anthropic.Beta.BetaMessageParam[] =
    mode == "explain" ? [{ role: "user", content: "Please explain how my heating budget is going this month." }] : messages;

  try {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: [
        { type: "text", text: GUIDE + "\n\n" + MODE_GUIDE[mode] },
        { type: "text", text: "The home's data (JSON):\n" + JSON.stringify(context) },
      ],
      tools: mode == "home" ? [proposeRooms] : undefined,
      tool_choice: mode == "home" ? { type: "auto" } : undefined,
      messages: conversation,
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);

    if (response.stop_reason == "refusal") {
      return json({ reply: "Sorry, I can't help with that one. Try asking about your heating, costs or budget." });
    }

    let reply = "";
    let proposal = null;
    for (const block of response.content) {
      if (block.type == "text") reply += block.text;
      else if (block.type == "tool_use" && block.name == "propose_rooms") proposal = block.input;
    }
    if (proposal && !reply.trim()) reply = "Here's what I've got. Check the rooms below and save them if they look right.";
    return json({ reply: reply.trim(), proposal });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return json({ error: "The assistant is busy. Try again in a minute." }, 503);
    if (error instanceof Anthropic.AuthenticationError) return json({ error: "The assistant isn't set up yet." }, 503);
    if (error instanceof Anthropic.APIError) return json({ error: `The assistant couldn't answer (${error.status}).` }, 502);
    throw error;
  }
});
