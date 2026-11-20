// Samy Nails admin-only Web Push dispatcher.
// This source is not deployed by repository changes. Configure secrets and deploy
// only after applying/reviewing the existing notification migration in Supabase.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-samy-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const ADMIN_PUSH_EVENTS = new Set(["booking_created", "booking_cancelled"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  const cronSecret = Deno.env.get("SAMY_PUSH_CRON_SECRET");
  if (!cronSecret || req.headers.get("x-samy-cron-secret") !== cronSecret) {
    return new Response("Unauthorized", { status: 401, headers: cors });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT");
  if (!url || !serviceKey || !publicKey || !privateKey || !subject) {
    return new Response("Push worker secrets are incomplete", { status: 503, headers: cors });
  }

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
  webpush.setVapidDetails(subject, publicKey, privateKey);

  const { data: admins, error: adminsError } = await supabase.from("admin_users").select("user_id");
  if (adminsError) return new Response("Could not load administrator recipients", { status: 500, headers: cors });
  const adminIds = new Set((admins || []).map((row) => String(row.user_id)));

  // Do not queue or deliver reminder/confirmation events for client accounts.
  // Only reservation-created and client-cancelled events addressed to an admin
  // are sent by this worker.
  const { data: events, error } = await supabase.rpc("samy_claim_push_outbox", { p_limit: 50 });
  if (error) return new Response("Could not claim push events", { status: 500, headers: cors });

  const results = [];
  for (const event of events || []) {
    const recipientIsAdmin = adminIds.has(String(event.recipient_user_id));
    if (!recipientIsAdmin || !ADMIN_PUSH_EVENTS.has(String(event.event_type))) {
      const { error: skipError } = await supabase.from("samy_push_outbox")
        .update({ sent_at: new Date().toISOString(), claimed_at: null, last_error: "Skipped: not an admin booking/cancellation push." })
        .eq("id", event.id);
      results.push({ id: event.id, sent: false, skipped: true, error: skipError?.message || null });
      continue;
    }

    const { data: subscriptions, error: subscriptionError } = await supabase.from("samy_push_subscriptions")
      .select("id,endpoint,p256dh,auth_secret")
      .eq("user_id", event.recipient_user_id);
    if (subscriptionError) {
      await supabase.from("samy_push_outbox").update({
        claimed_at: null,
        available_at: new Date(Date.now() + 60_000).toISOString(),
        last_error: "Could not load administrator push subscriptions.",
      }).eq("id", event.id);
      results.push({ id: event.id, sent: false });
      continue;
    }

    let failed = false;
    for (const sub of subscriptions || []) {
      const cancelled = event.event_type === "booking_cancelled";
      const message = {
        title: cancelled ? "Turno cancelado por la clienta" : "Nuevo turno reservado",
        body: event.payload?.message || (cancelled
          ? "Una clienta canceló su turno. Ese horario quedó disponible."
          : "Una clienta reservó un turno."),
        tag: String(event.id),
        renotify: false,
        data: { url: "/", booking_id: event.booking_id },
      };
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth_secret },
        }, JSON.stringify(message));
      } catch (pushError) {
        if (pushError?.statusCode === 404 || pushError?.statusCode === 410) {
          await supabase.from("samy_push_subscriptions").delete().eq("id", sub.id);
        } else {
          failed = true;
        }
      }
    }

    if (failed) {
      await supabase.from("samy_push_outbox").update({
        claimed_at: null,
        available_at: new Date(Date.now() + 60_000).toISOString(),
        last_error: "One or more administrator push deliveries failed.",
      }).eq("id", event.id);
      results.push({ id: event.id, sent: false });
    } else {
      await supabase.from("samy_push_outbox").update({
        sent_at: new Date().toISOString(),
        claimed_at: null,
        last_error: null,
      }).eq("id", event.id);
      results.push({ id: event.id, sent: true, subscriptions: subscriptions?.length || 0 });
    }
  }

  return new Response(JSON.stringify({ queued: events?.length || 0, results }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
