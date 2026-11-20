(() => {
  "use strict";

  const config = window.SAMY_SUPABASE_CONFIG;
  const ADMIN_SESSION_KEY = "samyNailsAdminSession";
  const NOTES_PREFIX = "[[SAMY_NAILS_V1]]";
  const $ = (id) => document.getElementById(id);
  let services = [];
  let busy = false;
  let initialized = false;
  let availabilityVersion = 0;

  const cancellationStatus = "cancelado";
  const cancelledStatuses = new Set(["cancelado", "cancelada", "canceled", "cancelled", "cancel"]);

  function escape(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function errorMessage(payload, fallback) {
    return payload?.message || payload?.msg || payload?.error_description || payload?.error || fallback;
  }

  function sessionFromStorage() {
    try { return JSON.parse(localStorage.getItem(ADMIN_SESSION_KEY) || "null"); } catch { return null; }
  }

  async function adminSession() {
    if (!config?.url || !config?.anonKey) throw new Error("Falta configurar Supabase.");
    let session = sessionFromStorage();
    if (!session?.access_token || !session?.user?.id) throw new Error("Ingresá al panel con una cuenta administradora.");
    if (session.expires_at && session.expires_at < Math.floor(Date.now() / 1000) + 30) {
      if (!session.refresh_token) throw new Error("La sesión de administración venció. Volvé a ingresar.");
      const refreshed = await fetch(`${config.url.replace(/\/$/, "")}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: { apikey: config.anonKey, "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
        cache: "no-store",
      });
      const auth = await refreshed.json().catch(() => ({}));
      if (!refreshed.ok) throw new Error(errorMessage(auth, "No se pudo renovar la sesión administrativa."));
      session = {
        ...auth,
        expires_at: auth.expires_at || Math.floor(Date.now() / 1000) + (auth.expires_in || 3600),
      };
      localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
    }

    const verify = await fetch(
      `${config.url.replace(/\/$/, "")}/rest/v1/admin_users?select=user_id&user_id=eq.${encodeURIComponent(session.user.id)}&limit=1`,
      { headers: { apikey: config.anonKey, Authorization: `Bearer ${session.access_token}` }, cache: "no-store" },
    );
    const admins = await verify.json().catch(() => []);
    if (!verify.ok || !Array.isArray(admins) || !admins.some((row) => String(row.user_id) === String(session.user.id))) {
      throw new Error("La sesión actual no tiene permisos de administración.");
    }
    return session;
  }

  async function adminRequest(path, { method = "GET", body, prefer } = {}) {
    const session = await adminSession();
    const headers = { apikey: config.anonKey, Authorization: `Bearer ${session.access_token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (prefer) headers.Prefer = prefer;
    const response = await fetch(`${config.url.replace(/\/$/, "")}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    if (!response.ok) throw new Error(errorMessage(payload, `Supabase respondió ${response.status}.`));
    return payload;
  }

  function ensurePanel() {
    const adminContent = $("adminContent");
    if (!adminContent || $("manualBookingSection")) return;
    const section = document.createElement("section");
    section.id = "manualBookingSection";
    section.className = "section";
    section.innerHTML = `
      <h3>Agregar turno manual</h3>
      <p class="noticeLine">Cargá turnos solicitados por WhatsApp, teléfono o personalmente.</p>
      <div class="fields">
        <div><label for="manualClientName">Nombre de la clienta</label><input id="manualClientName" maxlength="200" autocomplete="name"></div>
        <div><label for="manualClientPhone">Teléfono</label><input id="manualClientPhone" type="tel" maxlength="80" autocomplete="tel"></div>
        <div><label for="manualDate">Fecha</label><input id="manualDate" type="date"></div>
        <div><label for="manualTime">Horario disponible</label><select id="manualTime" disabled><option value="">Elegí fecha y servicios</option></select></div>
      </div>
      <label>Servicios</label>
      <div id="manualServices" class="services"><div class="empty">Cargando servicios…</div></div>
      <div id="manualDuration" class="noticeLine"></div>
      <div id="manualAvailabilityMessage" class="noticeLine" role="status"></div>
      <div id="manualSummary" class="summary hidden"></div>
      <div class="actions">
        <button id="manualPreview" class="secondary" type="button">REVISAR TURNO</button>
        <button id="manualSave" class="primary" type="button" disabled>CONFIRMAR TURNO</button>
      </div>
      <div id="manualMessage" role="status"></div>
      <div class="section">
        <h3>Cancelar un turno</h3>
        <div class="fields">
          <div><label for="adminCancelBooking">Turno activo</label><select id="adminCancelBooking"><option value="">Cargando turnos…</option></select></div>
          <div><label>&nbsp;</label><button id="adminCancelButton" class="danger" type="button" disabled>CANCELAR TURNO</button></div>
        </div>
        <div id="adminCancelMessage" role="status"></div>
      </div>`;
    adminContent.appendChild(section);

    $("manualDate").min = new Date().toLocaleDateString("en-CA");
    $("manualDate").addEventListener("change", () => refreshAvailableTimes());
    $("manualServices").addEventListener("change", (event) => {
      if (event.target.matches("input[type=checkbox]")) refreshAvailableTimes();
    });
    $("manualTime").addEventListener("change", () => {
      $("manualSummary").classList.add("hidden");
      $("manualSave").disabled = true;
    });
    $("manualPreview").addEventListener("click", showSummary);
    $("manualSave").addEventListener("click", saveManualBooking);
    $("adminCancelBooking").addEventListener("change", () => {
      $("adminCancelButton").disabled = !$("adminCancelBooking").value;
    });
    $("adminCancelButton").addEventListener("click", cancelBooking);
  }

  function selectedServices() {
    const ids = [...document.querySelectorAll("#manualServices input[type=checkbox]:checked")].map((input) => String(input.value));
    return ids.map((id) => services.find((service) => String(service.id) === id)).filter(Boolean);
  }

  function selectedDuration() {
    const chosen = selectedServices();
    if (!chosen.length) return 0;
    const longest = Math.max(...chosen.map((service) => Number(service.duration_minutes) || 0));
    return longest + (chosen.length > 1 ? 30 : 0);
  }

  async function loadServices() {
    const rows = await adminRequest("/rest/v1/services?select=id,name,duration_minutes,active&active=eq.true&order=created_at.asc");
    services = Array.isArray(rows) ? rows : [];
    const target = $("manualServices");
    if (!services.length) {
      target.innerHTML = '<div class="empty">Todavía no hay servicios activos.</div>';
      return;
    }
    target.innerHTML = services.map((service) => `
      <label class="service" style="display:flex;align-items:center;gap:8px">
        <input type="checkbox" value="${escape(service.id)}">
        <span><strong>${escape(service.name)}</strong><br><small>${escape(service.duration_minutes)} min</small></span>
      </label>`).join("");
  }

  async function refreshAvailableTimes() {
    const version = ++availabilityVersion;
    const date = $("manualDate").value;
    const chosen = selectedServices();
    const duration = selectedDuration();
    const timeSelect = $("manualTime");
    $("manualSummary").classList.add("hidden");
    $("manualSave").disabled = true;
    $("manualDuration").textContent = duration ? `Duración: ${duration} minutos` : "";
    timeSelect.replaceChildren(new Option("Consultando disponibilidad…", ""));
    timeSelect.disabled = true;
    $("manualAvailabilityMessage").textContent = "";
    if (!date || !chosen.length || !duration) {
      timeSelect.replaceChildren(new Option("Elegí fecha y servicios", ""));
      return;
    }
    try {
      const query = new URLSearchParams({
        select: "slot_time",
        slot_date: `eq.${date}`,
        active: "eq.true",
        order: "slot_time.asc",
      });
      const configured = await adminRequest(`/rest/v1/availability_slots?${query}`);
      if (version !== availabilityVersion) return;
      if (!configured?.length) {
        timeSelect.replaceChildren(new Option("Sin horarios configurados", ""));
        $("manualAvailabilityMessage").textContent = "No hay horarios configurados para esta fecha.";
        return;
      }
      const available = await adminRequest("/rest/v1/rpc/samy_available_slots", {
        method: "POST",
        body: { p_date: date, p_duration_minutes: duration },
      });
      if (version !== availabilityVersion) return;
      const times = (available || []).map((row) => String(typeof row === "string" ? row : row.slot_time).slice(0, 5));
      timeSelect.replaceChildren(new Option(times.length ? "Elegí un horario" : "Sin horarios disponibles", ""));
      for (const time of times) timeSelect.add(new Option(time, time));
      timeSelect.disabled = times.length === 0;
      if (!times.length) $("manualAvailabilityMessage").textContent = "Los horarios están ocupados o no alcanzan para esta duración.";
    } catch (error) {
      if (version !== availabilityVersion) return;
      timeSelect.replaceChildren(new Option("No se pudo cargar", ""));
      $("manualAvailabilityMessage").textContent = error.message || "No se pudo consultar la disponibilidad.";
    }
  }

  function showSummary() {
    const name = $("manualClientName").value.trim();
    const phone = $("manualClientPhone").value.trim();
    const date = $("manualDate").value;
    const time = $("manualTime").value;
    const chosen = selectedServices();
    if (!name || !phone || !date || !time || !chosen.length) {
      $("manualMessage").className = "notice err";
      $("manualMessage").textContent = "Completá nombre, teléfono, fecha, horario y al menos un servicio.";
      return;
    }
    const [year, month, day] = date.split("-");
    const names = chosen.map((service) => service.name);
    $("manualSummary").innerHTML = `<b>Revisá el turno</b><br>${escape(name)} · ${escape(phone)}<br>${escape(day)}/${escape(month)}/${escape(year)} · ${escape(time)}<br>${names.map(escape).join(" + ")}<br>Duración: ${selectedDuration()} minutos`;
    $("manualSummary").classList.remove("hidden");
    $("manualSave").disabled = false;
    $("manualMessage").textContent = "";
  }

  async function saveManualBooking() {
    if (busy) return;
    const name = $("manualClientName").value.trim();
    const phone = $("manualClientPhone").value.trim();
    const date = $("manualDate").value;
    const time = $("manualTime").value;
    const chosen = selectedServices();
    if (!name || !phone || !date || !time || !chosen.length) {
      showSummary();
      return;
    }
    busy = true;
    $("manualSave").disabled = true;
    $("manualMessage").className = "notice";
    $("manualMessage").textContent = "Guardando turno…";
    try {
      // Re-query immediately before booking; samy_create_booking performs the final
      // atomic availability/overlap validation and inserts into the shared bookings table.
      const fresh = await adminRequest("/rest/v1/rpc/samy_available_slots", {
        method: "POST",
        body: { p_date: date, p_duration_minutes: selectedDuration() },
      });
      const freshTimes = (fresh || []).map((row) => String(typeof row === "string" ? row : row.slot_time).slice(0, 5));
      if (!freshTimes.includes(time)) throw new Error("Ese horario acaba de ocuparse. Actualizá la disponibilidad y elegí otro.");

      const serviceIds = chosen.map((service) => String(service.id));
      const booking = await adminRequest("/rest/v1/rpc/samy_create_booking", {
        method: "POST",
        body: {
          p_client_name: name,
          p_client_phone: phone,
          p_booking_date: date,
          p_start_time: time,
          p_service_ids: serviceIds,
          p_notes: `${NOTES_PREFIX}${JSON.stringify({ notes: "Turno cargado manualmente por administración", service_ids: serviceIds })}`,
        },
      });
      if (!booking?.id) throw new Error("Supabase no devolvió el identificador de la reserva; no se puede confirmar que se haya guardado.");
      $("manualMessage").className = "notice ok";
      $("manualMessage").textContent = `Turno guardado. Estado: ${booking.status || "registrado"}.`;
      $("manualSummary").classList.add("hidden");
      $("manualClientName").value = "";
      $("manualClientPhone").value = "";
      $("manualDate").value = "";
      $("manualTime").replaceChildren(new Option("Elegí fecha y servicios", ""));
      $("manualServices").querySelectorAll("input[type=checkbox]").forEach((input) => { input.checked = false; });
      $("manualDuration").textContent = "";
      $("manualAvailabilityMessage").textContent = "";
      $("manualSave").disabled = true;
      await Promise.all([window.renderAdmin?.(), loadCancellationOptions()]);
    } catch (error) {
      $("manualMessage").className = "notice err";
      $("manualMessage").textContent = error.message || "No se pudo guardar el turno.";
      $("manualSave").disabled = false;
    } finally {
      busy = false;
    }
  }

  async function loadCancellationOptions() {
    const select = $("adminCancelBooking");
    if (!select) return;
    try {
      const today = new Date().toLocaleDateString("en-CA");
      const rows = await adminRequest(`/rest/v1/bookings?select=id,client_name,client_phone,booking_date,start_time,status&booking_date=gte.${today}&order=booking_date.asc,start_time.asc&limit=500`);
      select.replaceChildren(new Option(rows?.length ? "Elegí un turno" : "No hay turnos futuros", ""));
      for (const booking of rows || []) {
        if (cancelledStatuses.has(String(booking.status || "").toLowerCase())) continue;
        const date = String(booking.booking_date || "").slice(0, 10);
        const time = String(booking.start_time || "").slice(0, 5);
        const status = booking.status ? ` · ${booking.status}` : "";
        select.add(new Option(`${date} ${time} · ${booking.client_name} · ${booking.client_phone}${status}`, String(booking.id)));
      }
      $("adminCancelButton").disabled = !select.value;
    } catch (error) {
      select.replaceChildren(new Option("No se pudieron cargar los turnos", ""));
      $("adminCancelMessage").className = "notice err";
      $("adminCancelMessage").textContent = error.message || "No se pudieron cargar los turnos.";
    }
  }

  async function cancelBooking() {
    const id = $("adminCancelBooking").value;
    if (!id || busy) return;
    const choice = $("adminCancelBooking").selectedOptions[0]?.textContent || "este turno";
    if (!window.confirm(`¿Cancelar ${choice}?`)) return;
    busy = true;
    $("adminCancelButton").disabled = true;
    try {
      const rows = await adminRequest(`/rest/v1/bookings?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { status: cancellationStatus },
        prefer: "return=representation",
      });
      if (!Array.isArray(rows) || !rows.length) {
        throw new Error("Supabase no confirmó la cancelación. Revisá los permisos y el estado del turno.");
      }
      $("adminCancelMessage").className = "notice ok";
      $("adminCancelMessage").textContent = "Turno cancelado. El registro histórico se conserva.";
      await Promise.all([window.renderAdmin?.(), loadCancellationOptions()]);
    } catch (error) {
      $("adminCancelMessage").className = "notice err";
      $("adminCancelMessage").textContent = error.message || "No se pudo cancelar el turno.";
      $("adminCancelButton").disabled = false;
    } finally {
      busy = false;
    }
  }

  async function initializeWhenAdmin() {
    const content = $("adminContent");
    if (!content || content.classList.contains("hidden")) return;
    ensurePanel();
    if (initialized) {
      await loadCancellationOptions();
      return;
    }
    try {
      await adminSession();
      await loadServices();
      await loadCancellationOptions();
      initialized = true;
    } catch (error) {
      const message = $("manualMessage");
      if (message) {
        message.className = "notice err";
        message.textContent = error.message || "No se pudo verificar la sesión administrativa.";
      }
    }
  }

  function start() {
    ensurePanel();
    const content = $("adminContent");
    if (!content) return;
    const observer = new MutationObserver(() => {
      if (!content.classList.contains("hidden")) initializeWhenAdmin();
    });
    observer.observe(content, { attributes: true, attributeFilter: ["class"] });
    if (!content.classList.contains("hidden")) initializeWhenAdmin();
    // Existing admin login toggles visibility after its asynchronous login succeeds.
    setInterval(() => {
      if (!content.classList.contains("hidden")) initializeWhenAdmin();
    }, 2500);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
