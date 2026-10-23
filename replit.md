# Samy Nails on Replit

## Run

The existing single-page app is served by the built-in Node.js HTTP server:

```sh
node server.js
```

The Replit workflow uses port 5000. The server serves only the application files and image assets. It injects the Supabase URL and public `anon`/`publishable` key into the browser at runtime from the `SUPABASE_URL` and `SUPABASE_ANON_KEY` Secrets. Never put a Supabase `service_role` or `sb_secret_` key in this app.

## Supabase setup

The app uses the existing `services`, `availability_slots`, `bookings`, `settings`, `service_parallel`, and `admin_users` tables. Booking writes and public availability reads use the RPC functions in `supabase/migrations/20261022000000_samy_shared_booking_rpc.sql`. Apply that migration once in the existing Supabase project's SQL editor before enabling public bookings. It removes the direct public booking-insert policy and replaces it with a transaction-locked booking function; it does not recreate tables or delete booking data.

Administration signs in through Supabase Auth. The signed-in user's ID must have a row in `admin_users`, and the existing `is_admin()` policies must authorize it. The local-only `1234` password is not used for shared database administration.

Customer booking details remain readable only to administrators. Selected service IDs and the customer's note are stored together in the existing `bookings.notes` field using the `[[SAMY_NAILS_V1]]` metadata prefix because the existing bookings schema has no service-association column.
