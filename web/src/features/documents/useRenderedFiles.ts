import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from '../../api/client'
import { docKeys, filesPath, startRender, useFiles, waitForJob, type FileLinks } from './api'

const missing = (f: FileLinks, letter: boolean) => ({
  cv: !f.cv.pdf_url || !f.cv.up_to_date,
  letter: letter && !f.letter.pdf_url,
})

/**
 * The application's file links, rendering first when the CV (or the letter,
 * when asked) has no file yet or the decisions changed since the last render.
 * Rendering only typesets what the user already decided; it never changes
 * the CV.
 */
export function useRenderedFiles(id: string, { letter, enabled = true }: { letter: boolean; enabled?: boolean }) {
  const qc = useQueryClient()
  const files = useFiles(id)
  const lastAttempt = useRef('')

  const render = useMutation({
    mutationFn: async (withLetter: boolean) => {
      const started = await startRender(id, withLetter)
      const ids = [started.cv_job_id, started.letter_job_id].filter((j): j is string => !!j)
      const jobs = await Promise.all(ids.map((j) => waitForJob(j)))
      const fresh = await api.get<FileLinks>(filesPath(id))
      qc.setQueryData(docKeys.files(id), fresh)
      qc.invalidateQueries({ queryKey: ['documents'] })
      const still = missing(fresh, withLetter)
      if (jobs.some((j) => j.status === 'failed') || still.cv || still.letter) {
        throw new Error('Your files did not render. Try again.')
      }
      return fresh
    },
  })

  const need = files.data ? missing(files.data, letter) : null
  const needed = !!need && (need.cv || need.letter)
  const attemptKey = files.data ? `${letter}:${files.data.cv.rendered_at}:${need?.cv}:${need?.letter}` : ''

  useEffect(() => {
    if (!enabled || !needed || render.isPending) return
    if (lastAttempt.current === attemptKey) return
    lastAttempt.current = attemptKey
    render.mutate(letter)
  }, [enabled, needed, attemptKey, letter, render])

  return {
    files,
    preparing: render.isPending || (enabled && needed && !render.isError),
    renderError: render.error,
    retry: () => render.mutate(letter),
  }
}
