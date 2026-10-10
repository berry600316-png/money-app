/**
 * Hand a file to the user. On iPhone this opens the share sheet ("儲存到檔案"), so the user
 * chooses where it goes (spec 0.9). Must be called directly from a tap: Safari only allows
 * navigator.share during a user gesture, which is why the file is prepared beforehand.
 */
export type SaveResult = 'shared' | 'downloaded' | 'cancelled'

export async function saveFile(file: File): Promise<SaveResult> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] })
      return 'shared'
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
      throw e
    }
  }
  // Desktop browsers: a regular download.
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloaded'
}
