/**
 * The field catalog: which field carries the level, and which fields hold text,
 * per source. The names live in the config file so the documented knowledge
 * ("`level` returns nothing on logback, use `log_level`"; "EKS puts the line in
 * `log`") is used instead of re-derived at every query.
 */
import type { FieldCatalog, TargetKind } from './targets.ts'

/** What each source publishes when the file says nothing. */
const LEVEL_FIELD: Partial<Record<TargetKind, string>> = {
  kibana: 'log_level',
  opensearch: 'level',
}

const TEXT_FIELDS: Partial<Record<TargetKind, string[]>> = {
  kibana: ['message'],
  // The sUQer OpenSearch client searches exactly these three.
  opensearch: ['log', 'message', 'msg'],
}

export function levelField(kind: TargetKind, catalog: FieldCatalog): string | undefined {
  return catalog.level_field ?? LEVEL_FIELD[kind]
}

export function textFields(kind: TargetKind, catalog: FieldCatalog): string[] {
  return catalog.text_fields ?? TEXT_FIELDS[kind] ?? ['message']
}

/** `--level ERROR` as a clause, on the field the source actually publishes. */
export function levelClause(field: string, level: string): Record<string, unknown> {
  return { match: { [field]: level } }
}

/** `--text dispatchDe` as a clause, across the fields the source publishes. */
export function textClause(fields: string[], text: string): Record<string, unknown> {
  return fields.length === 1
    ? { match: { [fields[0]!]: text } }
    : { multi_match: { query: text, fields } }
}
