/**
 * Jira Cloud stores rich text as ADF (Atlassian Document Format). The CLI only
 * ever needs plain text: prose goes in as paragraphs, and an issue's description
 * or comment comes back out as text.
 */
import { isTable } from './values.ts'

export interface AdfDoc {
  type: 'doc'
  version: 1
  content: Record<string, unknown>[]
}

/** Node types whose children are inline, so they concatenate without a break. */
const INLINE_TYPES = ['text', 'hardBreak', 'mention', 'emoji', 'inlineCard', 'status', 'date']

/**
 * Split the text on blank lines and hand each block to Jira as one paragraph.
 * Single newlines stay inside the paragraph, which is what a plain-text author
 * means by them.
 */
export function textToAdf(text: string): AdfDoc {
  const content = text
    .split(/\n{2,}/)
    .filter((block) => block !== '')
    .map((block) => ({ type: 'paragraph', content: [{ type: 'text', text: block }] }))
  return { type: 'doc', version: 1, content }
}

/**
 * Flatten any ADF node to the text a human would read back: paragraphs join by
 * a blank line, a code block keeps its fence, and an unrecognised node is
 * recursed rather than dropped.
 */
export function adfToText(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(adfToText).join('')
  if (!isTable(node)) return ''

  const type = node['type']
  if (type === 'text') return typeof node['text'] === 'string' ? node['text'] : ''
  if (type === 'hardBreak') return '\n'

  const content = node['content']
  if (!Array.isArray(content)) return ''
  const parts = content.map(adfToText)
  if (type === 'paragraph') return parts.join('')
  if (type === 'codeBlock') return `\`\`\`\n${parts.join('')}\n\`\`\``
  const inline = content.every((child) => isTable(child) && INLINE_TYPES.includes(String(child['type'])))
  return parts.join(inline ? '' : '\n\n')
}
