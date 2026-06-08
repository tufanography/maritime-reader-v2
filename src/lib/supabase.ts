import { createClient } from '@supabase/supabase-js';

// Read-only Supabase client. Used ONLY at build time (getStaticPaths /
// .astro frontmatter). The anon key + RLS keep this read-only; nothing
// here is shipped to the browser because all reads resolve during build.
const url = import.meta.env.PUBLIC_SUPABASE_URL;
const anon = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anon) {
  throw new Error('Missing PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY in .env');
}

export const supabase = createClient(url, anon, {
  auth: { persistSession: false },
});
