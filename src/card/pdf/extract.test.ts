import { expect, it, vi } from 'vitest'

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  PasswordResponses: { INCORRECT_PASSWORD: 2 },
  getDocument,
}))

import { extractPdfText, PdfPasswordError } from './extract'

it('reads a password-protected PDF when streams have no async iterator, as on iPhone Safari', async () => {
  getDocument.mockImplementation(({ password }: { password?: string }) => {
    if (password !== 'test123') {
      return { promise: Promise.reject({ name: 'PasswordException', code: password ? 2 : 1 }) }
    }

    const page = {
      streamTextContent: () => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue({
              items: [{ str: '測試交易 100', transform: [1, 0, 0, 1, 10, 30], width: 80, height: 12 }],
            })
            controller.close()
          },
        })
        Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined })
        return stream
      },
      getTextContent: () => { throw new TypeError('readableStream is not async iterable') },
      cleanup: vi.fn(),
    }
    const doc = { numPages: 1, getPage: async () => page, destroy: vi.fn() }
    return { promise: Promise.resolve(doc) }
  })

  const data = new Uint8Array([1, 2, 3]).buffer
  await expect(extractPdfText(data)).rejects.toBeInstanceOf(PdfPasswordError)
  await expect(extractPdfText(data, 'wrong')).rejects.toMatchObject({ wrong: true })
  await expect(extractPdfText(data, 'test123')).resolves.toMatchObject({
    pages: 1,
    items: 1,
    lines: ['測試交易 100'],
  })
})
