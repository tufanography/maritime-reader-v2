// Frozen vocabulary (mirrors v1 classifier enums). Kept in one place so
// every page/component references the same canonical set.

export const THEMES = [
  'operational_risk',
  'compliance_regulation',
  'geopolitical_risk',
  'cargo_risk',
  'insurance_claims',
  'markets_trade',
  'decarbonization_energy',
  'safety_casualty',
] as const;
export type Theme = (typeof THEMES)[number];

export const SEGMENTS = [
  'tanker',
  'dry_bulk',
  'container',
  'lng_lpg',
  'offshore',
  'cruise',
] as const;
export type Segment = (typeof SEGMENTS)[number];

export const DOC_TYPES = [
  'news',
  'press_release',
  'pi_circular',
  'class_notice',
  'regulation',
  'market_report',
  'casualty_report',
  'psc_report',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

// Display labels — used for human-readable headings without re-typing.
export const THEME_LABEL: Record<Theme, string> = {
  operational_risk: 'Operational risk',
  compliance_regulation: 'Compliance & regulation',
  geopolitical_risk: 'Geopolitical risk',
  cargo_risk: 'Cargo risk',
  insurance_claims: 'Insurance & claims',
  markets_trade: 'Markets & trade',
  decarbonization_energy: 'Decarbonization & energy',
  safety_casualty: 'Safety & casualty',
};

export const SEGMENT_LABEL: Record<Segment, string> = {
  tanker: 'Tanker',
  dry_bulk: 'Dry bulk',
  container: 'Container',
  lng_lpg: 'LNG / LPG',
  offshore: 'Offshore',
  cruise: 'Cruise',
};

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  news: 'News',
  press_release: 'Press release',
  pi_circular: 'P&I Circular',
  class_notice: 'Class Notice',
  regulation: 'Regulation',
  market_report: 'Market Report',
  casualty_report: 'Casualty',
  psc_report: 'PSC Report',
};
