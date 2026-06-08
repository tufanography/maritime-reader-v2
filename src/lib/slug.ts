// URL-safe slug from arbitrary text. Used for source names like
// "London P&I Club" → "london-p-and-i-club".
//
// Round-trip is not always lossless (two sources whose slugs collide
// would be ambiguous), so pages that need the reverse mapping build it
// from the canonical source list at build time instead of inverting the
// slug directly.

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
