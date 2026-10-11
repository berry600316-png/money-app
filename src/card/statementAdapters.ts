/*
 * One adapter per bank's statement layout (D-97), built from a REAL (masked) statement. `detect` must
 * recognise the bank's layout from the text, not just the bank's name; `parse` reads the known columns.
 * A statement no adapter recognises is read by the generic strict reader in ./statementParser.ts and is
 * flagged as such.
 *
 * No real statement has been provided yet, so the registry is empty. To add a bank, see docs/adding-a-bank.md.
 */
import type { ParsedStatement } from './statementParser'

export interface StatementAdapter {
  /** Stored on the statement, e.g. "taishin-v1". */
  id: string
  bank: string
  /** True only for this bank's layout (several fixed headings, not just the bank's name). */
  detect(lines: readonly string[]): boolean
  parse(lines: readonly string[]): ParsedStatement
}

/** Registered adapters. Empty until real statements arrive. */
export const STATEMENT_ADAPTERS: StatementAdapter[] = []
