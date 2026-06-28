// Query expansion for hybrid search — the #1 measured recall lever (POC:
// vocab-gap recall 27%->66%). Bridges maritime vocabulary gaps so a user who
// types "ship blaze" also matches articles that say "fire".
//
// IMPORTANT — Pagefind uses AND semantics across query terms, so we CANNOT just
// append synonyms (that would narrow results). Instead we build VARIANT queries
// (the original term swapped for each synonym) and the caller runs one Pagefind
// search per variant, then RRF-merges the result sets — an OR across synonyms.
//
// $0, deterministic, client-side. The hand-curated seed dictionary below is the
// safe, shippable version; the self-learning jargon miner GROWS it later (under
// guardrails: support>=5, boilerplate strip, quarantine, human review).

export const SYNONYM_GROUPS: string[][] = [
  ['fire', 'blaze', 'inferno'],
  ['collision', 'allision'],
  ['sinking', 'sank', 'foundering', 'foundered'],
  ['capsize', 'capsized', 'overturned'],
  ['grounding', 'aground', 'ran aground', 'stranded'],
  ['oil spill', 'spill', 'hydrocarbon discharge', 'pollution'],
  ['sanctions', 'embargo', 'restrictions', 'blacklisted'],
  ['detention', 'detained', 'port state control', 'deficiencies'],
  ['crew', 'seafarers', 'mariners'],
  ['abandonment', 'unpaid crew', 'stranded seafarers'],
  ['piracy', 'armed robbery', 'hijacking'],
  ['scrubber', 'scrubbers', 'exhaust gas cleaning', 'egcs'],
  ['decarbonisation', 'decarbonization', 'green shipping', 'energy transition'],
  ['lng', 'liquefied natural gas'],
  ['lpg', 'liquefied petroleum gas'],
  ['newbuilding', 'newbuild', 'newly ordered'],
  ['congestion', 'port backlog', 'backlog', 'delays'],
  ['bunker', 'marine fuel', 'bunkering'],
  ['tanker', 'crude carrier', 'product carrier'],
  ['bulk carrier', 'bulker', 'dry bulk'],
  ['container ship', 'boxship', 'containership'],
  ['shadow fleet', 'dark fleet', 'sanctioned tankers'],
  ['salvage', 'wreck removal', 'wreck recovery'],
  ['casualty', 'maritime accident'],
  ['emissions', 'ghg', 'greenhouse gas'],
  ['drydock', 'dry dock', 'ship repair'],
  ['cyber attack', 'ransomware', 'cyber incident'],
];

// term -> list of [matchedTerm, synonym] pairs for substitution.
const INDEX: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      const key = term.toLowerCase();
      const others = group.filter((o) => o.toLowerCase() !== key);
      m.set(key, (m.get(key) ?? []).concat(others));
    }
  }
  return m;
})();

const boundary = (term: string) =>
  new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');

/** Build OR-variant queries for a search term. Returns the original query first,
 *  then one variant per applicable synonym (the matched maritime term swapped
 *  for the synonym). Deduped, capped. The caller runs a Pagefind search per
 *  variant and RRF-merges. Returns [query] unchanged when nothing matches. */
export function expandToVariants(query: string, maxVariants = 6): string[] {
  const q = query.trim();
  if (!q) return [q];
  const lower = ` ${q.toLowerCase()} `;
  const variants = new Set<string>([q]);
  for (const [term, syns] of INDEX) {
    if (!boundary(term).test(lower)) continue;
    for (const syn of syns) {
      // Replace the matched term with the synonym (word-boundary safe).
      const re = new RegExp(`(^|[^a-zA-Z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-zA-Z0-9]|$)`, 'i');
      const swapped = q.replace(re, (_m, a, b) => `${a}${syn}${b}`);
      if (swapped.toLowerCase() !== q.toLowerCase()) variants.add(swapped);
      if (variants.size > maxVariants) break;
    }
    if (variants.size > maxVariants) break;
  }
  return [...variants];
}

/** RRF-merge several ranked result lists (each an array of items with a stable
 *  `id`). The original-query list is passed first and gets a small weight bonus
 *  so exact matches stay on top. Returns merged items, best first. */
export function rrfMerge<T extends { id: string }>(lists: T[][], k = 60, limit = 30): T[] {
  const score = new Map<string, number>();
  const byId = new Map<string, T>();
  lists.forEach((list, li) => {
    const weight = li === 0 ? 1.15 : 1; // bonus for the original (unexpanded) query
    list.forEach((item, rank) => {
      if (!item || !item.id) return;
      score.set(item.id, (score.get(item.id) ?? 0) + weight / (k + rank));
      if (!byId.has(item.id)) byId.set(item.id, item);
    });
  });
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => byId.get(id)!);
}
