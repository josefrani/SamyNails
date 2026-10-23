---
name: Alcance de la integración de Supabase
description: Restricciones del usuario para continuar el proyecto importado Samy Nails.
---

Continuar el proyecto existente Samy Nails sin reconstruirlo desde cero ni cambiar su diseño o funciones existentes. Priorizar conectar reservas, servicios y horarios con la base Supabase ya creada, reemplazando el almacenamiento local de reservas por persistencia compartida. Evitar cambios innecesarios; informar primero los archivos a modificar y cómo se conectará Supabase. No afirmar que está terminado hasta probarlo.

El usuario confirmó que la URL y la clave pública funcionan, y confirmó los nombres de columnas de `services`, `availability_slots`, `bookings`, `settings` y `service_parallel`. No volver a pedir ni repetir esas verificaciones.

**Why:** el usuario pidió estas restricciones expresamente.

**How to apply:** adaptar la integración al esquema existente y conservar el comportamiento de la aplicación; no sustituir la base, rediseñar la interfaz ni pedir de nuevo los datos de conexión/esquema confirmados.
