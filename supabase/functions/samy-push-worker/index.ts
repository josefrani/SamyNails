// Prepared worker contract. Deploy only after the migration and client subscription UI
// have been reviewed and tested in a separate Supabase staging project.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-samy-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });
  const cronSecret = Deno.env.get("SAMY_PUSH_CRON_SECRET");
  if (!cronSecret || req.headers.get("x-samy-cron-secret") !== cronSecret) return new Response("Unauthorized", { status: 401, headers: cors });
  const url = Deno.env.get("SUPABASE_URL"), serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY"), privateKey = Deno.env.get("VAPID_PRIVATE_KEY"), subject = Deno.env.get("VAPID_SUBJECT");
  if (!url || !serviceKey || !publicKey || !privateKey || !subject) return new Response("Push worker secrets are incomplete", { status: 503, headers: cors });

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
  webpush.setVapidDetails(subject, publicKey, privateKey);
  const { error: reminderError } = await supabase.rpc("samy_enqueue_due_reminders");
  if (reminderError) return new Response("Could not queue reminders", { status: 500, headers: cors });
  const { data: events, error } = await supabase.rpc("samy_claim_push_outbox", { p_limit: 50 });
  if (error) return new Response("Could not claim push events", { status: 500, headers: cors });

  const results = [];
  for (const event of events || []) {
    const { data: subscriptions } = await supabase.from("samy_push_subscriptions")
      .select("id,endpoint,p256dh,auth_secret").eq("user_id", event.recipient_user_id);
    let failed = false;
    for (const sub of subscriptions || []) {
      const message = {
        title: event.event_type === "booking_reminder" ? "¡Mañana te esperamos en Samy Nails! 💜" : event.event_type === "booking_cancelled" ? "Turno cancelado" : "Novedad de Samy Nails",
        body: event.payload?.message || "Tenés una notificación nueva en Samy Nails.",
        tag: String(event.id),
        data: { url: "/", booking_id: event.booking_id },
      };
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_secret } }, JSON.stringify(message));
      } catch (e) {
        if (e?.statusCode === 404 || e?.statusCode === 410) await supabase.from("samy_push_subscriptions").delete().eq("id", sub.id);
        else failed = true;
      }
    }
    if (failed) {
      await supabase.from("samy_push_outbox").update({ attempts: (event.attempts || 0) + 1, claimed_at: null, available_at: new Date(Date.now() + 60_000).toISOString(), last_error: "One or more push sends failed" }).eq("id", event.id);
      results.push({ id: event.id, sent: false });
    } else {
      await supabase.from("samy_push_outbox").update({ sent_at: new Date().toISOString(), claimed_at: null, attempts: (event.attempts || 0) + 1, last_error: null }).eq("id", event.id);
      results.push({ id: event.id, sent: true });
    }
  }
  return new Response(JSON.stringify({ queued: events?.length || 0, results }), { headers: { ...cors, "Content-Type": "application/json" } });
});
