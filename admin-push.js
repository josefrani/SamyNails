(() => {
  "use strict";

  const config = window.SAMY_SUPABASE_CONFIG;
  const pushConfig = window.SAMY_PUSH_CONFIG;
  const ADMIN_SESSION_KEY = "samyNailsAdminSession";
  const $ = (id) => document.getElementById(id);
  let button;
  let message;
  let initialized = false;

  function decodeBase64Url(value) {
    const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const raw = atob(padded);
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  }

  function encodeKey(value) {
    return btoa(String.fromCharCode(...new Uint8Array(value)));
  }

  function setMessage(text, kind = "noticeLine") {
    if (!message) return;
    message.className = kind;
    message.textContent = text;
  }

  function adminSessionFromStorage() {
    try { return JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY) || "null"); } catch { return null; }
  }

  async function getAdminSession() {
    const session = adminSessionFromStorage();
    if (!session?.access_token || !session?.user?.id) throw new Error("Ingresá al panel con una cuenta administradora.");
    if (session.expires_at && session.expires_at <= Math.floor(Date.now() / 1000) + 30) {
      throw new Error("La sesión de administración venció. Volvé a ingresar antes de activar notificaciones.");
    }
    const response = await fetch(
      `${config.url.replace(/\/$/, "")}/rest/v1/admin_users?select=user_id&user_id=eq.${encodeURIComponent(session.user.id)}&limit=1`,
      { headers: { apikey: config.anonKey, Authorization: `Bearer ${session.access_token}` }, cache: "no-store" },
    );
    const admins = await response.json().catch(() => []);
    if (!response.ok || !Array.isArray(admins) || !admins.some((row) => String(row.user_id) === String(session.user.id))) {
      throw new Error("La sesión actual no tiene permisos de administración.");
    }
    return session;
  }

  async function api(path, session, { method = "GET", body, prefer } = {}) {
    const headers = { apikey: config.anonKey, Authorization: `Bearer ${session.access_token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (prefer) headers.Prefer = prefer;
    const response = await fetch(`${config.url.replace(/\/$/, "")}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || payload.msg || `Supabase respondió ${response.status}.`);
    return payload;
  }

  function ensureControls() {
    const content = $("adminContent");
    if (!content || $("adminPushSection")) return;
    const section = document.createElement("section");
    section.id = "adminPushSection";
    section.className = "section";
    section.innerHTML = `
      <h3>Notificaciones para Samy</h3>
      <p class="noticeLine">Activá las notificaciones en este dispositivo para recibir avisos de reservas y cancelaciones de clientas.</p>
      <button id="adminPushButton" type="button" class="secondary">ACTIVAR NOTIFICACIONES</button>
      <div id="adminPushMessage" role="status" class="noticeLine"></div>`;
    content.appendChild(section);
    button = $("adminPushButton");
    message = $("adminPushMessage");
    button.addEventListener("click", subscribeAdminDevice);
  }

  async function renderState() {
    if (!button) return;
    if (!config?.url || !config?.anonKey || !pushConfig?.vapidPublicKey) {
      button.disabled = true;
      setMessage("Falta configurar Supabase o VAPID_PUBLIC_KEY en el servidor.", "notice err");
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      button.disabled = true;
      setMessage("Este navegador o dispositivo no admite notificaciones push.", "notice err");
      return;
    }
    const permission = Notification.permission;
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    if (subscription && permission === "granted") {
      button.textContent = "NOTIFICACIONES ACTIVAS EN ESTE DISPOSITIVO";
      button.disabled = true;
      setMessage("Este dispositivo está suscrito para recibir notificaciones administrativas.");
    } else if (permission === "denied") {
      button.disabled = true;
      setMessage("El permiso fue rechazado. Podés habilitarlo desde la configuración del navegador.", "notice err");
    } else {
      button.disabled = false;
      button.textContent = "ACTIVAR NOTIFICACIONES";
    }
  }

  async function subscribeAdminDevice() {
    if (!button) return;
    button.disabled = true;
    try {
      if (!config?.url || !config?.anonKey || !pushConfig?.vapidPublicKey) {
        throw new Error("Falta configurar SUPABASE_URL, SUPABASE_ANON_KEY o VAPID_PUBLIC_KEY.");
      }
      const session = await getAdminSession();
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("Este navegador o dispositivo no admite notificaciones push.");
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("No se concedió permiso para mostrar notificaciones.");

      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeBase64Url(pushConfig.vapidPublicKey),
        });
      }
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error("El navegador devolvió una suscripción push incompleta.");
      }
      await api("/rest/v1/samy_push_subscriptions?on_conflict=endpoint", session, {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        body: {
          user_id: session.user.id,
          endpoint: json.endpoint,
          p256dh: json.keys.p256dh,
          auth_secret: json.keys.auth,
        },
      });
      setMessage("Notificaciones activadas para Samy en este dispositivo.", "notice ok");
      await renderState();
    } catch (error) {
      setMessage(error.message || "No se pudo activar la suscripción push.", "notice err");
      button.disabled = false;
    }
  }

  function watchAdminPanel() {
    const content = $("adminContent");
    if (!content || initialized) return;
    initialized = true;
    ensureControls();
    const observer = new MutationObserver(() => {
      if (!content.classList.contains("hidden")) renderState().catch((error) => setMessage(error.message, "notice err"));
    });
    observer.observe(content, { attributes: true, attributeFilter: ["class"] });
    if (!content.classList.contains("hidden")) renderState().catch((error) => setMessage(error.message, "notice err"));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", watchAdminPanel, { once: true });
  else watchAdminPanel();
})();
