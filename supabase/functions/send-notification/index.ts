// Emails a notification (season advice) to the members of its home.
//
// Called by the home's controller just after it adds a notification.
// Sends through Resend when the RESEND_API_KEY secret is set (and
// NOTIFY_FROM, e.g. "Heating <heating@yourdomain>"); without them it does
// nothing and the notification still shows on the dashboard.
//
// POST { "notification_id": "..." }  with the controller's own access token

import { createClient } from "jsr:@supabase/supabase-js@2";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const resendKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("NOTIFY_FROM");
  const dashboardUrl = Deno.env.get("DASHBOARD_URL") ?? "";
  if (!resendKey || !from) return json({ sent: 0, reason: "email not configured" });

  let notificationId: string;
  try {
    notificationId = (await req.json()).notification_id;
  } catch {
    return json({ error: "Send a JSON body" }, 400);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });

  // row-level security: only the home's own controller (or members) can see it
  const { data: note, error } = await caller
    .from("notifications")
    .select("id, home_id, title, body, emailed_at")
    .eq("id", notificationId)
    .single();
  if (error || !note) return json({ error: "Notification not found" }, 404);
  if (note.emailed_at) return json({ sent: 0, reason: "already sent" });

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: members } = await admin
    .from("home_members")
    .select("user_id")
    .eq("home_id", note.home_id)
    .eq("notify_email", true);

  let sent = 0;
  for (const m of members ?? []) {
    const { data: user } = await admin.auth.admin.getUserById(m.user_id);
    const to = user?.user?.email;
    if (!to) continue;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to,
        subject: note.title,
        text: `${note.body}\n\n${dashboardUrl}`,
        html: `<p>${escapeHtml(note.body)}</p>${dashboardUrl ? `<p><a href="${escapeHtml(dashboardUrl)}">Open your heating dashboard</a></p>` : ""}`,
      }),
    });
    if (res.ok) sent++;
  }

  await admin.from("notifications").update({ emailed_at: new Date().toISOString() }).eq("id", note.id);
  return json({ sent });
});
