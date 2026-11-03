import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
// Publishable key (sb_publishable_...). Falls back to the legacy variable name so an
// existing .env keeps working while you migrate off the legacy anon key.
const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy .env.example to .env and fill in your project values.",
  );
}

// Only the PUBLISHABLE key belongs in the frontend. Row-level security does the
// enforcement. Never put a secret key (or the legacy service_role key) here or
// anywhere in this repo.
export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
