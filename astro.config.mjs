import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Phase 0: pure static output. Pages are pre-rendered at build time from
// the live Supabase DB; the deployed artifact is plain HTML/CSS/JS with
// zero server compute and zero runtime DB/AI dependency (HANDOFF §3).
//
// Tailwind v4 via the Vite plugin (no @astrojs/tailwind integration —
// the v4 native pipeline is faster, plugin-free, and CSS-only).
// Frontend port slice 1 (2026-05-31) added this.
export default defineConfig({
  output: 'static',
  site: 'https://maritimereader.com',
  vite: {
    plugins: [tailwindcss()],
  },
});
