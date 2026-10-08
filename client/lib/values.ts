/**
 * The one place "is this parsed document a table?" is answered. Everything else
 * in the CLI narrows the fields it actually reads with `typeof`, so a weak guard
 * never stands in for real validation.
 */
export function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
