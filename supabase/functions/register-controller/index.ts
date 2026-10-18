// Registers a new heating controller (Raspberry Pi).
//
// The controller sends a long random password it has generated. This creates
// a Supabase user for it, plus a claim code the customer types into the
// dashboard to link the controller to their account.
//
// POST { "password": "...", "software_version": "..." }
//   -> { "controller_id", "email", "claim_code" }

import { createClient } from "jsr:@supabase/supabase-js@2";

// No 0/O, 1/I/L, so codes are easy to read off a screen or label
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function claimCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return chars.slice(0, 4) + "-" + chars.slice(4);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  let body: { password?: unknown; software_version?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send a JSON body" }, 400);
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 32 || password.length > 128) {
    return json({ error: "password must be 32 to 128 characters" }, 400);
  }
  const version = typeof body.software_version === "string" ? body.software_version.slice(0, 40) : null;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const id = crypto.randomUUID();
  const email = `controller-${id}@controllers.heating.invalid`;

  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: "controller", controller_id: id },
  });
  if (userError || !created.user) {
    return json({ error: userError?.message ?? "Could not create controller" }, 500);
  }

  // retry on the rare clash with an existing code
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: row, error } = await admin
      .from("controllers")
      .insert({ id, auth_user_id: created.user.id, claim_code: claimCode(), software_version: version })
      .select("id, claim_code")
      .single();

    if (!error) return json({ controller_id: row.id, email, claim_code: row.claim_code });
    if (error.code !== "23505") break;
  }

  await admin.auth.admin.deleteUser(created.user.id);
  return json({ error: "Could not register controller" }, 500);
});
