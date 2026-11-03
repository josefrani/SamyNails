# Samy Nails: identidad de clientas y notificaciones (preparación)

**Esta migración no está aplicada.** `20261104000000_samy_customer_identity_notifications.sql` es una propuesta para revisar antes de ejecutar en Supabase.

## Modelo de identidad

- Cada instalación crea una sesión de Supabase Auth anónima (sin SMS, contraseña ni correo).
- El UUID de Auth se guarda en `bookings.customer_user_id` al crear reservas nuevas.
- Nombre y teléfono son datos de contacto, no factores de autorización.
- `samy_my_bookings()` y `samy_cancel_my_booking(text)` limitan la operación al UUID de la sesión.
- Las reservas históricas conservan `customer_user_id = NULL`: no se intenta inferir su titular por coincidencia de nombre/teléfono.
- Si la clienta borra datos, cambia de navegador/dispositivo o pierde la sesión, la identidad anónima no se puede recuperar de forma segura. Para recuperar datos entre dispositivos se necesitaría posteriormente un método de vinculación fuerte (por ejemplo, passkey o correo verificado); no se propone SMS.

## Compatibilidad y alcance de la migración

- Agrega columna nullable e índices; no borra ni transforma reservas antiguas.
- Reemplaza el cuerpo de `samy_create_booking` conservando el bloqueo por fecha, solapamiento, validación de horarios y agrupación por `service_parallel` (máximo de duración dentro de grupos compatibles).
- Las reservas nuevas requieren sesión Auth autenticada, incluidas las sesiones anónimas. Hasta integrar esa sesión en el cliente, aplicar la migración bloquearía reservas desde la app antigua; por eso **no aplicar antes de completar y probar la integración frontend**.
- Admin conserva sus reservas/historial por los mecanismos administrativos existentes; las reservas históricas siguen sin dueño de clienta.
- El RPC de cancelación solo permite cancelar turnos propios futuros/en curso del día según la hora local de Buenos Aires. No elimina filas. La cancelación administrativa no notifica a la clienta.
- El trigger crea notificaciones internas y entradas push para reservas nuevas; una cancelación iniciada por la identidad dueña avisa a administradores, mientras que la cancelación de administración no genera aviso para la clienta.

## Push y programación

La migración persiste suscripciones push, outbox y claims de recordatorio con unicidad por reserva. Todavía hace falta completar e integrar el cliente (registro de sesión anónima, campana, permisos y `PushManager.subscribe`) y desplegar un trabajador Edge protegido que procese el outbox.

Configuración futura necesaria, siempre en secretos y nunca en Git:

- Auth anónimo habilitado en Supabase.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y `VAPID_SUBJECT` para Web Push.
- `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` solo en Edge Function.
- Invocación programada del trabajador al menos una vez por minuto para llamar `samy_enqueue_due_reminders()` y enviar outbox pendientes.
- Permiso de notificaciones del navegador y soporte Push API/Service Worker; sin permiso/dispositivo compatible, solo quedarán las notificaciones internas al abrir la app.

La tarea horaria consulta zona `America/Argentina/Buenos_Aires`; su ventana de cola es 23:59–24:01 antes del turno porque un scheduler no garantiza ejecución en un instante exacto. Un registro único evita reencolar el recordatorio, pero Web Push es una entrega de red de mejor esfuerzo; no se puede garantizar exactamente una recepción en cada dispositivo.

## Revisión necesaria antes de aplicar

1. Verificar en la base real el tipo de `bookings.id`, `status`, RLS y `is_admin()`; esta migración asume los campos y tablas que ya usa el RPC actual.
2. Probar en una base de staging con la migración original aplicada, primero `samy_available_slots`, reservas paralelas, solapamientos, perfil anónimo, consulta propia, intento de leer/cancelar otra clienta y cancelación admin.
3. Integrar frontend y Edge Function, configurar VAPID y cron; no aplicar primero a producción.
4. Revisar la operación de los turnos manuales de clientas sin cuenta: no se asignarán a partir del teléfono; requieren un procedimiento explícito de enlace en una etapa posterior.

No se ejecutó SQL ni se cambió la configuración del proyecto Supabase al preparar este archivo.
