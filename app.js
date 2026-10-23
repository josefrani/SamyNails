(() => {
  "use strict";

  const config = window.SAMY_SUPABASE_CONFIG;
  const LOCAL_PRESENTATION_KEY = "samyNailsPresentationV1";
  const LEGACY_KEY = "samyV4Fixed";
  const SESSION_KEY = "samyNailsAdminSession";
  const NOTES_PREFIX = "[[SAMY_NAILS_V1]]";
  const MIGRATION_NAME = "supabase/migrations/20261022000000_samy_shared_booking_rpc.sql";
  const $ = (id) => document.getElementById(id);

  let session = null;
  let isAdmin = false;
  let loadVersion = 0;
  let adminServices = [];
  let weekRows = [];
  const myBookings = [];

  try {
    const savedSession = localStorage.getItem(SESSION_KEY);
    session = savedSession ? JSON.parse(savedSession) : null;
  } catch {
    session = null;
  }

  try {
    const presentation = JSON.parse(localStorage.getItem(LOCAL_PRESENTATION_KEY) || "null")
      || JSON.parse(localStorage.getItem(LEGACY_KEY) || "null")
      || {};
    db.logo = presentation.logo || "";
    db.promo = presentation.promo || "";
    db.promoCaption = presentation.promoCaption || "";
  } catch {
    db.logo = "";
    db.promo = "";
    db.promoCaption = "";
  }

  // Do not use the old device-local service, schedule, or booking cache.
  db.services = [];
  db.hours = {};
  db.bookings = [];
  db.parallel = {};

  function savePresentation() {
    localStorage.setItem(LOCAL_PRESENTATION_KEY, JSON.stringify({
      logo: db.logo || "",
      promo: db.promo || "",
      promoCaption: db.promoCaption || "",
    }));
  }

  function configReady() {
    return Boolean(config?.url && config?.anonKey);
  }

  function publicKey() {
    return config.anonKey;
  }

  function storeSession(value) {
    session = value;
    if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else localStorage.removeItem(SESSION_KEY);
  }

  function errorFrom(response, payload) {
    const error = new Error(
      payload?.message || payload?.msg || payload?.error_description || payload?.error || `Supabase respondió ${response.status}.`,
    );
    error.status = response.status;
    error.code = payload?.code || payload?.error_code || "";
    return error;
  }

  async function refreshSession() {
    if (!session?.refresh_token || !configReady()) {
      storeSession(null);
      return false;
    }
    const response = await fetch(
      `${config.url.replace(/\/$/, "")}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: { apikey: publicKey(), "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      storeSession(null);
      isAdmin = false;
      return false;
    }
    storeSession({
      ...payload,
      expires_at: payload.expires_at || Math.floor(Date.now() / 1000) + (payload.expires_in || 3600),
    });
    return true;
  }

  async function api(path, options = {}, retried = false) {
    if (!configReady()) throw new Error("Falta configurar la URL y la clave pública de Supabase en Secrets.");

    const auth = options.auth !== false;
    if (auth && session?.refresh_token && session.expires_at
      && session.expires_at < Math.floor(Date.now() / 1000) + 20) {
      await refreshSession();
    }

    const headers = { apikey: publicKey(), ...(options.headers || {}) };
    if (auth) headers.Authorization = `Bearer ${session?.access_token || publicKey()}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.prefer) headers.Prefer = options.prefer;

    const response = await fetch(`${config.url.replace(/\/$/, "")}${path}`, {
      method: options.method || "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    if (response.status === 401 && auth && !retried && session?.refresh_token) {
      if (await refreshSession()) return api(path, options, true);
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    if (!response.ok) throw errorFrom(response, payload);
    return payload;
  }

  function describeError(error) {
    const text = String(error?.message || "");
    if (error?.code === "PGRST202" || /samy_available_slots|samy_create_booking|schema cache/i.test(text)) {
      return `Falta aplicar la migración ${MIGRATION_NAME} en Supabase.`;
    }
    if (/invalid login credentials/i.test(text)) return "Correo o contraseña incorrectos.";
    if (/email not confirmed/i.test(text)) return "Confirmá el correo de la cuenta de administración antes de ingresar.";
    if (/slot_unavailable/i.test(text)) return "Ese horario acaba de ocuparse. Elegí otro.";
    if (/services_unavailable/i.test(text)) return "Uno de los servicios seleccionados ya no está disponible. Actualizá la página.";
    if (/booking_date_in_past/i.test(text)) return "Elegí una fecha de hoy o posterior.";
    if (/invalid_service_selection|invalid_booking_details/i.test(text)) return "Revisá los servicios y los datos del turno.";
    if (error?.status === 401 || error?.status === 403) return "Supabase no autorizó esta operación. Revisá el acceso de la cuenta de administración y las políticas RLS.";
    if (error?.status === 404) return `No se encontró un recurso necesario en Supabase. Revisá que exista el esquema y aplicá ${MIGRATION_NAME}.`;
    return text || "No se pudo completar la operación. Revisá la conexión e intentá de nuevo.";
  }

  function eq(value) {
    return `eq.${encodeURIComponent(String(value))}`;
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function setNotice(element, text, kind = "err") {
    if (!element) return;
    element.className = `notice ${kind}`;
    element.textContent = text;
  }

  function normalizeService(row) {
    return {
      id: String(row.id),
      name: String(row.name || ""),
      duration: Number(row.duration_minutes),
      active: row.active !== false,
    };
  }

  function setParallel(rows) {
    const map = {};
    for (const row of rows || []) {
      const from = String(row.service_id);
      const to = String(row.parallel_service_id);
      if (!map[from]) map[from] = [];
      if (!map[from].includes(to)) map[from].push(to);
    }
    db.parallel = map;
  }

  async function loadParallel() {
    const rows = await api("/rest/v1/service_parallel?select=service_id,parallel_service_id");
    setParallel(rows);
    return rows;
  }

  async function loadPublicData() {
    const [rows] = await Promise.all([
      api("/rest/v1/services?select=id,name,duration_minutes,active&active=eq.true&order=created_at.asc"),
      loadParallel(),
    ]);
    db.services = (rows || []).map(normalizeService);
    renderServices();
  }

  function selected() {
    return [...document.querySelectorAll(".service.sel")].map((button) => String(button.dataset.id));
  }

  function canParallel(a, b) {
    if (String(a) === String(b)) return true;
    return Boolean(db.parallel?.[String(a)]?.includes(String(b)));
  }

  function total() {
    const ids = selected();
    if (!ids.length) return 0;
    const groups = [];
    for (const id of ids) {
      const service = db.services.find((item) => String(item.id) === id);
      if (!service) continue;
      const group = groups.find((members) => members.every((member) => canParallel(member.id, id)));
      if (group) group.push({ id, duration: service.duration });
      else groups.push([{ id, duration: service.duration }]);
    }
    return groups.reduce((sum, group) => sum + Math.max(...group.map((member) => member.duration)), 0);
  }

  function renderServices() {
    const target = $("services");
    if (!target) return;
    target.replaceChildren();
    const active = db.services.filter((service) => service.active);
    if (!active.length) {
      target.innerHTML = '<div class="empty">Todavía no hay servicios disponibles.</div>';
      return;
    }
    for (const service of active) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "service";
      button.dataset.id = String(service.id);
      button.innerHTML = `<strong>${escapeHTML(service.name)}</strong><span>${dur(service.duration)}</span>`;
      button.addEventListener("click", () => {
        button.classList.toggle("sel");
        const ids = selected();
        $("info").classList.toggle("hidden", !ids.length);
        if (ids.length) $("info").textContent = `Seleccionaste ${ids.length} servicio(s) · duración total: ${dur(total())}`;
        slots();
      });
      target.appendChild(button);
    }
  }

  async function slots() {
    const version = ++loadVersion;
    const target = $("slotsBox");
    if (!target) return;
    target.replaceChildren();
    const date = $("date").value;
    const duration = total();
    if (!date || !duration) {
      target.innerHTML = '<div class="empty">Elegí una fecha y servicios.</div>';
      return;
    }
    target.innerHTML = '<div class="empty">Consultando disponibilidad…</div>';
    try {
      const query = new URLSearchParams({
        select: "slot_time",
        slot_date: eq(date),
        active: "eq.true",
        order: "slot_time.asc",
      });
      const configured = await api(`/rest/v1/availability_slots?${query}`);
      if (version !== loadVersion) return;
      if (!configured?.length) {
        target.innerHTML = '<div class="empty">Samy todavía no configuró horarios para esta fecha.</div>';
        return;
      }
      const available = await api("/rest/v1/rpc/samy_available_slots", {
        method: "POST",
        body: { p_date: date, p_duration_minutes: duration },
      });
      if (version !== loadVersion) return;
      const times = (available || []).map((row) => String(typeof row === "string" ? row : row.slot_time).slice(0, 5));
      if (!times.length) {
        target.innerHTML = '<div class="empty">Los horarios configurados para esta fecha no están disponibles para la duración elegida.</div>';
        return;
      }
      for (const time of times) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "slot";
        button.textContent = time;
        button.addEventListener("click", () => {
          document.querySelectorAll(".slot").forEach((item) => item.classList.remove("sel"));
          button.classList.add("sel");
        });
        target.appendChild(button);
      }
    } catch (error) {
      if (version === loadVersion) target.innerHTML = `<div class="empty">${escapeHTML(describeError(error))}</div>`;
    }
  }

  function packNotes(notes, serviceIds) {
    return `${NOTES_PREFIX}${JSON.stringify({ notes, service_ids: serviceIds })}`;
  }

  function unpackNotes(value) {
    const text = String(value || "");
    if (!text.startsWith(NOTES_PREFIX)) return { notes: text, serviceIds: [] };
    try {
      const parsed = JSON.parse(text.slice(NOTES_PREFIX.length));
      return { notes: String(parsed.notes || ""), serviceIds: (parsed.service_ids || []).map(String) };
    } catch {
      return { notes: text, serviceIds: [] };
    }
  }

  async function confirmTurn() {
    const clientName = $("name").value.trim();
    const phone = $("phone").value.trim();
    const date = $("date").value;
    const slot = document.querySelector(".slot.sel");
    const serviceIds = selected();
    const duration = total();
    if (!clientName || !phone || !date || !slot || !duration || !serviceIds.length) {
      setNotice($("msg"), "Completá nombre, teléfono, fecha, servicios y horario.");
      return;
    }
    const button = document.querySelector("#book .primary");
    button.disabled = true;
    try {
      const booking = await api("/rest/v1/rpc/samy_create_booking", {
        method: "POST",
        body: {
          p_client_name: clientName,
          p_client_phone: phone,
          p_booking_date: date,
          p_start_time: slot.textContent,
          p_service_ids: serviceIds,
          p_notes: $("notes").value.trim(),
        },
      });
      myBookings.unshift({
        id: booking?.id || String(Date.now()),
        name: clientName,
        phone,
        date,
        slot: slot.textContent,
        duration: Number(booking?.duration_minutes || duration),
        services: serviceIds,
        notes: $("notes").value.trim(),
        status: "pendiente",
      });
      setNotice($("msg"), "¡Turno solicitado correctamente!", "ok");
      renderMine();
      await slots();
      setTimeout(back, 900);
    } catch (error) {
      setNotice($("msg"), describeError(error));
      await slots();
    } finally {
      button.disabled = false;
    }
  }

  function renderMine() {
    const target = $("mine");
    if (!target) return;
    const clientName = $("name").value.trim().toLocaleLowerCase();
    const own = myBookings.filter((booking) => !clientName || booking.name.toLocaleLowerCase() === clientName);
    if (!own.length) {
      target.innerHTML = '<div class="empty">Los turnos que confirmes durante esta visita aparecerán aquí.</div>';
      return;
    }
    target.innerHTML = own.map((booking) => {
      const names = booking.services.map((id) => db.services.find((service) => String(service.id) === String(id))?.name || "Servicio").join(" + ");
      return `<div class="booking"><b>${escapeHTML(booking.date)} · ${escapeHTML(booking.slot)}</b><br>${escapeHTML(names)}<br><small>${escapeHTML(dur(booking.duration))}${booking.notes ? ` · ${escapeHTML(booking.notes)}` : ""}</small></div>`;
    }).join("");
  }

  function ensureAdminEmailField() {
    const loginBox = $("adminLoginBox");
    if (!$("adminEmail")) {
      const passwordLabel = $("pass").previousElementSibling;
      const label = document.createElement("label");
      label.htmlFor = "adminEmail";
      label.textContent = "Correo de administración";
      const input = document.createElement("input");
      input.id = "adminEmail";
      input.type = "email";
      input.autocomplete = "username";
      input.placeholder = "tu correo";
      const form = document.createElement("form");
      form.id = "adminLoginForm";
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        doAdminLogin();
      });
      passwordLabel.before(form);
      form.append(label, input, passwordLabel, $("pass"));
      const loginButton = loginBox.querySelector(".primary");
      const recoveryButton = loginBox.querySelector(".secondary");
      if (loginButton) loginButton.type = "button";
      if (recoveryButton) recoveryButton.type = "button";
    }
    $("pass").autocomplete = "current-password";
    const resetButton = loginBox.querySelector(".secondary");
    if (resetButton) resetButton.textContent = "RECUPERAR ACCESO POR EMAIL";
    if (!$("adminLoginMsg")) {
      const notice = document.createElement("div");
      notice.id = "adminLoginMsg";
      loginBox.appendChild(notice);
    }
    if (!$("adminLogout")) {
      const logout = document.createElement("button");
      logout.id = "adminLogout";
      logout.className = "secondary";
      logout.textContent = "CERRAR SESIÓN";
      logout.onclick = logoutAdmin;
      $("adminContent").prepend(logout);
    }
  }

  async function verifyAdminSession() {
    if (!session?.access_token) return false;
    try {
      const userId = session.user?.id;
      if (!userId) return false;
      const query = new URLSearchParams({
        select: "user_id",
        user_id: eq(userId),
        limit: "1",
      });
      const rows = await api(`/rest/v1/admin_users?${query}`);
      isAdmin = Boolean(rows?.length);
      if (!isAdmin) storeSession(null);
      return isAdmin;
    } catch {
      isAdmin = false;
      storeSession(null);
      return false;
    }
  }

  async function openAdmin() {
    ensureAdminEmailField();
    $("adminPanel").classList.remove("hidden");
    $("adminLoginMsg").textContent = "";
    if (await verifyAdminSession()) {
      $("adminLoginBox").style.display = "none";
      $("adminContent").classList.remove("hidden");
      await renderAdmin();
    } else {
      $("adminLoginBox").style.display = "block";
      $("adminContent").classList.add("hidden");
      $("pass").value = "";
    }
  }

  function closeAdmin() {
    $("adminPanel").classList.add("hidden");
  }

  async function doAdminLogin() {
    ensureAdminEmailField();
    const email = $("adminEmail").value.trim();
    const password = $("pass").value;
    if (!email || !password) {
      setNotice($("adminLoginMsg"), "Ingresá el correo y la contraseña de tu cuenta de administración.");
      return;
    }
    try {
      const payload = await api("/auth/v1/token?grant_type=password", {
        method: "POST",
        auth: false,
        body: { email, password },
      });
      storeSession({
        ...payload,
        expires_at: payload.expires_at || Math.floor(Date.now() / 1000) + (payload.expires_in || 3600),
      });
      if (!await verifyAdminSession()) {
        setNotice($("adminLoginMsg"), "La cuenta inició sesión, pero no tiene un registro habilitado en admin_users.");
        return;
      }
      $("adminLoginBox").style.display = "none";
      $("adminContent").classList.remove("hidden");
      $("adminLoginMsg").textContent = "";
      await renderAdmin();
    } catch (error) {
      setNotice($("adminLoginMsg"), describeError(error));
    }
  }

  async function resetAdminPassword() {
    const email = $("adminEmail")?.value.trim();
    if (!email) {
      setNotice($("adminLoginMsg"), "Ingresá tu correo para recibir el enlace de recuperación.");
      return;
    }
    try {
      await api("/auth/v1/recover", { method: "POST", auth: false, body: { email } });
      setNotice($("adminLoginMsg"), "Si el correo está registrado, Supabase enviará un enlace de recuperación.", "ok");
    } catch (error) {
      setNotice($("adminLoginMsg"), describeError(error));
    }
  }

  function logoutAdmin() {
    storeSession(null);
    isAdmin = false;
    $("adminContent").classList.add("hidden");
    $("adminLoginBox").style.display = "block";
    $("pass").value = "";
    $("adminLoginMsg").textContent = "Sesión cerrada.";
  }

  async function renderAdmin() {
    try {
      const [services, links, bookings] = await Promise.all([
        api("/rest/v1/services?select=id,name,duration_minutes,active,created_at&order=created_at.asc"),
        loadParallel(),
        api("/rest/v1/bookings?select=id,client_name,client_phone,booking_date,start_time,duration_minutes,notes,status,created_at&order=booking_date.desc,start_time.asc&limit=500"),
      ]);
      adminServices = (services || []).map(normalizeService);
      db.services = adminServices;
      setParallel(links);
      renderAdminServices();
      renderParallel();
      renderAdminBookings(bookings || []);
      $("promoCaption").value = db.promoCaption || "";
      await renderWeekEditor();
      renderServices();
    } catch (error) {
      setNotice($("adminLoginMsg"), describeError(error));
      $("adminBookings").innerHTML = `<div class="empty">${escapeHTML(describeError(error))}</div>`;
    }
  }

  function renderAdminServices() {
    const target = $("adminServices");
    if (!adminServices.length) {
      target.innerHTML = '<div class="empty">Todavía no hay servicios configurados.</div>';
      return;
    }
    target.innerHTML = adminServices.map((service, index) => `
      <div class="asvc">
        <input class="name" aria-label="Nombre del servicio" value="${escapeHTML(service.name)}" onchange="updateService(${index},'name',this.value)">
        <input class="dur" aria-label="Duración en minutos" type="number" min="15" step="15" value="${service.duration}" onchange="updateService(${index},'duration',this.value)">
        <button type="button" class="secondary" aria-label="Activar o pausar servicio" onclick="toggleServiceActive(${index})">${service.active ? "ACTIVO" : "PAUSADO"}</button>
        <button type="button" class="danger" aria-label="Eliminar servicio" onclick="removeService(${index})">×</button>
      </div>`).join("");
  }

  async function updateService(index, field, value) {
    const service = adminServices[index];
    if (!service) return;
    const patch = field === "name" ? { name: String(value).trim() } : { duration_minutes: Number(value) };
    if (field === "name" && !patch.name) {
      renderAdminServices();
      return;
    }
    if (field === "duration" && (!Number.isInteger(patch.duration_minutes) || patch.duration_minutes < 15)) {
      renderAdminServices();
      return;
    }
    try {
      await api(`/rest/v1/services?id=${eq(service.id)}`, { method: "PATCH", body: patch });
      await renderAdmin();
    } catch (error) {
      alert(describeError(error));
      renderAdminServices();
    }
  }

  async function toggleServiceActive(index) {
    const service = adminServices[index];
    if (!service) return;
    try {
      await api(`/rest/v1/services?id=${eq(service.id)}`, {
        method: "PATCH",
        body: { active: !service.active },
      });
      await renderAdmin();
    } catch (error) {
      alert(describeError(error));
    }
  }

  async function addService() {
    try {
      await api("/rest/v1/services", {
        method: "POST",
        prefer: "return=representation",
        body: { name: "Nuevo servicio", duration_minutes: 60, active: true },
      });
      await renderAdmin();
    } catch (error) {
      alert(describeError(error));
    }
  }

  async function removeService(index) {
    const service = adminServices[index];
    if (!service || !confirm(`¿Eliminar el servicio “${service.name}”?`)) return;
    try {
      await api(`/rest/v1/service_parallel?service_id=${eq(service.id)}`, { method: "DELETE" });
      await api(`/rest/v1/service_parallel?parallel_service_id=${eq(service.id)}`, { method: "DELETE" });
      await api(`/rest/v1/services?id=${eq(service.id)}`, { method: "DELETE" });
      await renderAdmin();
    } catch (error) {
      alert(describeError(error));
    }
  }

  function mondayOf(value) {
    const date = new Date(`${value}T12:00:00`);
    const day = date.getDay();
    date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
    return date;
  }

  function iso(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function renderWeekEditor() {
    return loadWeekEditor();
  }

  async function loadWeekEditor() {
    const value = $("adminWeek").value;
    if (!value) return;
    const monday = mondayOf(value);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    const start = iso(monday);
    const end = iso(sunday);
    const rows = await api(`/rest/v1/availability_slots?select=id,slot_date,slot_time,active&slot_date=gte.${start}&slot_date=lte.${end}&order=slot_date.asc,slot_time.asc`);
    weekRows = rows || [];
    const byDate = {};
    for (const row of weekRows) {
      const key = String(row.slot_date).slice(0, 10);
      (byDate[key] ||= []).push(row);
    }
    let html = "";
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + dayIndex);
      const key = iso(date);
      const values = (byDate[key] || [])
        .filter((row) => row.active)
        .map((row) => String(row.slot_time).slice(0, 5));
      html += `<div class="card" style="margin:10px 0;padding:12px">
        <label style="margin-top:0">${escapeHTML(date.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "2-digit" }))}</label>
        <input class="weekSlot" data-date="${key}" value="${escapeHTML(values.join(", "))}" placeholder="09:00, 10:00, 11:00">
        <div style="font-size:11px;color:var(--mut);margin-top:5px">${values.length ? "✓ Horarios guardados para este día." : "Dejá vacío si ese día no trabaja."}</div>
      </div>`;
    }
    $("weekEditor").innerHTML = html;
  }

  async function saveWeek() {
    const inputs = [...document.querySelectorAll(".weekSlot")];
    if (!inputs.length) {
      setNotice($("weekMsg"), "No hay días para guardar.");
      return;
    }
    const desired = new Map();
    for (const input of inputs) {
      const values = [...new Set(input.value.split(",").map((value) => value.trim()).filter(Boolean))];
      if (values.some((value) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) {
        setNotice($("weekMsg"), "Usá horarios con formato HH:MM, separados por comas.");
        return;
      }
      desired.set(input.dataset.date, values);
    }
    try {
      const wantedRows = new Map();
      for (const row of weekRows) {
        const key = String(row.slot_date).slice(0, 10);
        const time = String(row.slot_time).slice(0, 5);
        const isWanted = desired.get(key)?.includes(time) || false;
        if (isWanted && !wantedRows.has(`${key}|${time}`)) wantedRows.set(`${key}|${time}`, row);
        else if (row.active) {
          await api(`/rest/v1/availability_slots?id=${eq(row.id)}`, {
            method: "PATCH",
            body: { active: false },
          });
        }
      }
      for (const [date, times] of desired) {
        for (const time of times) {
          const existing = wantedRows.get(`${date}|${time}`);
          if (existing) {
            if (!existing.active) {
              await api(`/rest/v1/availability_slots?id=${eq(existing.id)}`, {
                method: "PATCH",
                body: { active: true },
              });
            }
          } else {
            await api("/rest/v1/availability_slots", {
              method: "POST",
              body: { slot_date: date, slot_time: time, active: true },
            });
          }
        }
      }
      await loadWeekEditor();
      await slots();
      setNotice($("weekMsg"), "✓ Horarios guardados correctamente. Ya están disponibles para pedir turnos.", "ok");
      setTimeout(() => { $("weekMsg").textContent = ""; }, 4000);
    } catch (error) {
      setNotice($("weekMsg"), describeError(error));
    }
  }

  async function renderParallel() {
    const target = $("parallelMatrix");
    if (!target) return;
    if (!adminServices.length) {
      target.innerHTML = '<div class="empty">Agregá servicios primero.</div>';
      return;
    }
    const headings = adminServices.map((service) => `<th style="padding:7px">${escapeHTML(service.name)}</th>`).join("");
    const rows = adminServices.map((left) => `<tr>
      <td style="padding:7px;font-weight:700;border-top:1px solid var(--line)">${escapeHTML(left.name)}</td>
      ${adminServices.map((right) => {
        if (String(left.id) === String(right.id)) return '<td style="text-align:center;border-top:1px solid var(--line)">—</td>';
        const checked = canParallel(left.id, right.id);
        return `<td style="text-align:center;border-top:1px solid var(--line)">
          <input type="checkbox" aria-label="${escapeHTML(left.name)} y ${escapeHTML(right.name)} combinables" ${checked ? "checked" : ""}
            onchange="toggleParallel('${escapeHTML(left.id)}','${escapeHTML(right.id)}',this.checked)">
        </td>`;
      }).join("")}
    </tr>`).join("");
    target.innerHTML = `<div style="overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><tr><th style="text-align:left;padding:7px">Servicio</th>${headings}</tr>${rows}</table></div>`;
  }

  async function toggleParallel(leftId, rightId, enabled) {
    const left = String(leftId);
    const right = String(rightId);
    try {
      if (enabled) {
        for (const [service_id, parallel_service_id] of [[left, right], [right, left]]) {
          const query = new URLSearchParams({ select: "service_id", service_id: eq(service_id), parallel_service_id: eq(parallel_service_id), limit: "1" });
          const existing = await api(`/rest/v1/service_parallel?${query}`);
          if (!existing?.length) {
            await api("/rest/v1/service_parallel", {
              method: "POST",
              body: { service_id, parallel_service_id },
            });
          }
        }
      } else {
        await api(`/rest/v1/service_parallel?service_id=${eq(left)}&parallel_service_id=${eq(right)}`, { method: "DELETE" });
        await api(`/rest/v1/service_parallel?service_id=${eq(right)}&parallel_service_id=${eq(left)}`, { method: "DELETE" });
      }
      await loadParallel();
      await renderParallel();
      await slots();
    } catch (error) {
      alert(describeError(error));
      await renderAdmin();
    }
  }

  function renderAdminBookings(bookings) {
    const target = $("adminBookings");
    if (!bookings.length) {
      target.innerHTML = '<div class="empty">No hay turnos.</div>';
      return;
    }
    target.innerHTML = bookings.slice().reverse().map((booking) => {
      const meta = unpackNotes(booking.notes);
      const names = meta.serviceIds.map((id) => adminServices.find((service) => String(service.id) === id)?.name || "Servicio eliminado").join(" + ");
      const date = String(booking.booking_date || "").slice(0, 10);
      const time = String(booking.start_time || "").slice(0, 5);
      return `<div class="booking">
        <b>${escapeHTML(booking.client_name)}</b> · ${escapeHTML(date)} ${escapeHTML(time)}
        <br><small>${escapeHTML(booking.client_phone)}${booking.status ? ` · ${escapeHTML(booking.status)}` : ""}</small>
        ${names ? `<br>${escapeHTML(names)}` : ""}
        <br><small>${escapeHTML(dur(Number(booking.duration_minutes) || 0))}${meta.notes ? ` · ${escapeHTML(meta.notes)}` : ""}</small>
      </div>`;
    }).join("");
  }

  function image(input, type) {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      db[type] = reader.result;
      savePresentation();
      apply();
    };
    reader.readAsDataURL(file);
  }

  function apply() {
    if (db.logo) {
      $("logoImg").src = db.logo;
      $("logoImg").classList.remove("hidden");
      $("fallback").classList.add("hidden");
    } else {
      $("logoImg").removeAttribute("src");
      $("logoImg").classList.add("hidden");
      $("fallback").classList.remove("hidden");
    }
    if (db.promo) {
      $("promo").style.display = "block";
      $("promoImg").src = db.promo;
      $("promoText").textContent = db.promoCaption || "";
    } else {
      $("promo").style.display = "none";
    }
  }

  function removePromo() {
    db.promo = "";
    db.promoCaption = "";
    savePresentation();
    apply();
    if (isAdmin) renderAdmin();
  }

  async function changePass() {
    const password = $("newPass").value.trim();
    if (!password) {
      alert("Ingresá una contraseña nueva.");
      return;
    }
    try {
      const updated = await api("/auth/v1/user", { method: "PUT", body: { password } });
      if (session) {
        session.user = updated;
        storeSession(session);
      }
      $("newPass").value = "";
      alert("Contraseña de Supabase actualizada.");
    } catch (error) {
      alert(describeError(error));
    }
  }

  async function initialize() {
    ensureAdminEmailField();
    $("services").innerHTML = '<div class="empty">Cargando servicios…</div>';
    $("mine").innerHTML = '<div class="empty">Los turnos que confirmes durante esta visita aparecerán aquí.</div>';
    apply();
    $("promoCaption").onchange = () => {
      db.promoCaption = $("promoCaption").value;
      savePresentation();
      apply();
    };
    $("name").addEventListener("input", () => {
      $("hello").textContent = $("name").value ? `Hola ${$("name").value}` : "Hola";
      renderMine();
    });
    try {
      await loadPublicData();
    } catch (error) {
      $("services").innerHTML = `<div class="empty">${escapeHTML(describeError(error))}</div>`;
    }
    const today = new Date();
    const monday = mondayOf(iso(today));
    $("adminWeek").value = iso(monday);
    if (session?.access_token) await verifyAdminSession();
  }

  Object.assign(window, {
    renderServices,
    selected,
    canParallel,
    total,
    slots,
    confirmTurn,
    renderMine,
    openAdmin,
    closeAdmin,
    doAdminLogin,
    resetAdminPassword,
    renderAdmin,
    addService,
    removeService,
    updateService,
    toggleServiceActive,
    renderWeekEditor,
    saveWeek,
    renderParallel,
    toggleParallel,
    image,
    apply,
    removePromo,
    changePass,
  });

  initialize();
})();
