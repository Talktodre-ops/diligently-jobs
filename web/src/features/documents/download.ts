// Handing files to the person: a real download, or the phone's share sheet.

/**
 * Starts a download of a presigned link. The link carries
 * Content-Disposition: attachment with the API's file name, so the browser
 * saves it under that name and stays on this page.
 */
export function triggerDownload(url: string) {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export type ShareFile = { url: string; name: string; type: string }

export const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const

/** True where the browser can hand files to the system share sheet (phones, some desktops). */
export function canShareFiles(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function' || typeof File === 'undefined') return false
  try {
    return navigator.canShare({ files: [new File([''], 'probe.pdf', { type: MIME.pdf })] })
  } catch {
    return false
  }
}

export async function fetchAsFiles(files: ShareFile[]): Promise<File[]> {
  return Promise.all(
    files.map(async (f) => {
      const res = await fetch(f.url)
      if (!res.ok) throw new Error(`download failed (${res.status})`)
      return new File([await res.blob()], f.name, { type: f.type })
    }),
  )
}

export type ShareOutcome = 'shared' | 'downloaded' | 'cancelled'

/**
 * Opens the share sheet with `files` when the browser supports it, otherwise
 * downloads each file. Cancelling the sheet is reported, not treated as an
 * error. `ready` are File objects fetched ahead of the tap, so the share call
 * still has the user's gesture behind it.
 */
export async function shareOrDownload(files: ShareFile[], ready?: File[] | null, title?: string): Promise<ShareOutcome> {
  if (files.length === 0) throw new Error('nothing to share')
  if (canShareFiles()) {
    try {
      const list = ready && ready.length === files.length ? ready : await fetchAsFiles(files)
      if (navigator.canShare({ files: list })) {
        await navigator.share({ files: list, title })
        return 'shared'
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
      // NotAllowedError (the gesture expired) or a fetch failure: fall through to a plain download.
    }
  }
  files.forEach((f, i) => setTimeout(() => triggerDownload(f.url), i * 400))
  return 'downloaded'
}
