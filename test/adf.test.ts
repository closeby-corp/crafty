import { describe, expect, test } from 'bun:test'
import { adfToText, textToAdf } from '../src/adf.ts'

describe('textToAdf', () => {
  test('one paragraph per block, with the document envelope Jira wants', () => {
    expect(textToAdf('hello')).toEqual({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    })
  })

  test('blank lines separate paragraphs', () => {
    const doc = textToAdf('first\n\nsecond')
    expect(doc.content).toHaveLength(2)
    expect(adfToText(doc)).toBe('first\n\nsecond')
  })

  test('empty text is an empty document', () => {
    expect(textToAdf('')).toEqual({ type: 'doc', version: 1, content: [] })
    expect(adfToText(textToAdf(''))).toBe('')
  })
})

describe('round trips', () => {
  const cases: string[] = ['hello world', 'first\nsecond', 'a\n\nb', 'a\n\nb\n\nc', 'trailing\n', '🥔 unicode']

  for (const value of cases) {
    test(JSON.stringify(value), () => {
      expect(adfToText(textToAdf(value))).toBe(value)
    })
  }

  test('more than two newlines collapse to one blank line', () => {
    expect(adfToText(textToAdf('a\n\n\n\nb'))).toBe('a\n\nb')
  })
})

describe('adfToText on foreign documents', () => {
  test('a code block keeps its fence', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'codeBlock', attrs: { language: 'sh' }, content: [{ type: 'text', text: 'echo hi' }] },
      ],
    }
    expect(adfToText(doc)).toBe('```\necho hi\n```')
  })

  test('paragraphs inside an unknown node recurse, joined by blank lines', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
          ],
        },
      ],
    }
    expect(adfToText(doc)).toBe('a\n\nb')
  })

  test('an unknown node holding inline children concatenates them', () => {
    const panel = {
      type: 'panel',
      attrs: { type: 'info' },
      content: [
        { type: 'text', text: 'held ' },
        { type: 'text', text: 'together' },
      ],
    }
    expect(adfToText(panel)).toBe('held together')
  })

  test('hard breaks and null content are handled', () => {
    expect(adfToText({ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
    expect(adfToText({ type: 'rule' })).toBe('')
    expect(adfToText(null)).toBe('')
  })
})
