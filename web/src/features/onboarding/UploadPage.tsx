import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { profileKey, useMe } from '../../auth/session'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { TextField } from '../../ui/TextField'
import { toFormError } from '../auth/errors'
import { cvCounts, fileProblem, MAX_UPLOAD_BYTES, useMaster, useSaveMaster, useStartUpload, useUpdateProfile, useUpload } from './api'
import { OnboardFrame } from './components/OnboardFrame'
import s from './UploadPage.module.css'

const STORE = 'dl.onboarding.upload'
function remembered(): string | null {
  try {
    return sessionStorage.getItem(STORE)
  } catch {
    return null
  }
}
function remember(id: string | null) {
  try {
    if (id) sessionStorage.setItem(STORE, id)
    else sessionStorage.removeItem(STORE)
  } catch {
    // Storage can be blocked; the page still works, it just cannot resume a read after a reload.
  }
}

export default function UploadPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const me = useMe()
  const master = useMaster()
  const start = useStartUpload()
  const saveMaster = useSaveMaster()
  const updateProfile = useUpdateProfile()
  const [uploadId, setUploadId] = useState<string | null>(remembered)
  const [replacing, setReplacing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [handMode, setHandMode] = useState(false)
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const upload = useUpload(uploadId)

  const status = upload.data?.status
  // An upload id remembered from another session may no longer resolve: treat it as no upload rather than spin forever.
  const lost = upload.isError
  useEffect(() => {
    if (lost) remember(null)
  }, [lost])
  useEffect(() => {
    if (status === 'done') {
      remember(null)
      void qc.invalidateQueries({ queryKey: profileKey })
      void qc.invalidateQueries({ queryKey: ['cv', 'master'] })
    }
  }, [status, qc])

  function choose(file: File | undefined) {
    if (!file) return
    const p = fileProblem(file)
    setProblem(p)
    if (p) return
    start.mutate(file, {
      onSuccess: ({ upload: u }) => {
        remember(u.id)
        setUploadId(u.id)
        setReplacing(false)
      },
      onError: (err) => setProblem(toFormError(err).message),
    })
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    choose(e.dataTransfer.files[0])
  }

  async function byHand(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      setNameError('Enter your name as it should appear on your CV.')
      return
    }
    setNameError(null)
    try {
      await saveMaster.mutateAsync({
        header: { name: name.trim(), title: '', email: me.data?.email ?? null },
        experience: [], education: [], skills: [], projects: [],
      })
      await updateProfile.mutateAsync({ onboarding_step: 'check' })
      navigate('/onboarding/check')
    } catch (err) {
      setNameError(toFormError(err).message)
    }
  }

  const reading = !!uploadId && !lost && (!upload.data || status === 'queued' || status === 'reading' || (status === 'done' && !master.data))
  const failed = !!uploadId && !lost && status === 'failed'
  const hasCv = !!master.data && !reading && !failed && !replacing
  const busy = start.isPending

  const counts = master.data ? cvCounts(master.data.doc) : null

  return (
    <OnboardFrame
      step="upload"
      footer={
        hasCv ? (
          <Button block onClick={() => navigate('/onboarding/check')}>Continue</Button>
        ) : (
          <p className={s.privacy}>Your CV stays private to your account. You can delete it any time.</p>
        )
      }
    >
      <div className={s.heading}>
        <h1 className={s.title}>Start with your CV</h1>
        <p className={s.lede}>This becomes your master CV. Every application is tailored from it, and nothing on it is invented.</p>
      </div>

      {!reading && !hasCv && !handMode && (
        <div className={s.stack}>
          {failed && (
            <Notice tone="error">
              We could not read that file. {upload.data?.error ?? 'Try another copy, or build it by hand.'}
            </Notice>
          )}
          <input
            ref={input}
            type="file"
            className="visually-hidden"
            tabIndex={-1}
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            aria-label="CV file"
            onChange={(e) => {
              choose(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <button
            type="button"
            className={`${s.drop} ${dragging ? s.dragging : ''}`}
            onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            disabled={busy}
          >
            <span className={s.dropIcon}><Icon name="upload" size={26} strokeWidth={1.8} /></span>
            <span className={s.dropTitle}>{busy ? 'Uploading' : 'Upload PDF or DOCX'}</span>
            <span className={s.dropNote}>Up to {MAX_UPLOAD_BYTES / 1024 / 1024} MB. Your LinkedIn PDF works too.</span>
          </button>
          {problem && <p className={s.problem} role="alert">{problem}</p>}
          <Button variant="secondary" block onClick={() => setHandMode(true)}>Build it by hand instead</Button>
          {replacing && <Button variant="ghost" block onClick={() => setReplacing(false)}>Keep my current CV</Button>}
        </div>
      )}

      {!reading && !hasCv && handMode && (
        <form className={s.stack} onSubmit={byHand} noValidate>
          <p className={s.lede}>Start with your name. You can add roles, education and skills from your profile afterwards.</p>
          <TextField label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={nameError} />
          <Button type="submit" busy={saveMaster.isPending || updateProfile.isPending} block>Continue</Button>
          <Button variant="ghost" block onClick={() => setHandMode(false)}>Upload a file instead</Button>
        </form>
      )}

      {reading && (
        <div className={s.card} role="status" aria-live="polite">
          <div className={s.cardRow}>
            <span className={s.kind}>{upload.data?.kind?.toUpperCase() ?? 'CV'}</span>
            <div className={s.cardText}>
              <div className={s.fileName}>{upload.data?.filename ?? 'Your CV'}</div>
              <div className={s.fileNote}>
                {status === 'reading' ? 'Reading it and pulling out roles, bullets and skills' : 'Waiting for a reader to pick it up'}
              </div>
            </div>
          </div>
          <div className={s.track}>
            <div className={s.fill} style={{ width: status === 'reading' ? '65%' : '20%' }} />
          </div>
        </div>
      )}

      {hasCv && counts && (
        <div className={s.card}>
          <div className={s.cardRow}>
            <span className={s.tick}><Icon name="check" size={22} strokeWidth={2.2} /></span>
            <div className={s.cardText}>
              <div className={s.fileName}>{upload.data?.filename ?? 'Your master CV'}</div>
              <div className={s.fileNote}>{upload.data ? 'Read in full' : 'Saved to your account'}</div>
            </div>
            <Button variant="ghost" small onClick={() => { setReplacing(true); setUploadId(null); remember(null) }}>Replace</Button>
          </div>
          <div className={s.counts}>
            <div><span className={s.num}>{counts.roles}</span><span className={s.unit}>{counts.roles === 1 ? 'role' : 'roles'}</span></div>
            <div><span className={s.num}>{counts.bullets}</span><span className={s.unit}>{counts.bullets === 1 ? 'bullet' : 'bullets'}</span></div>
            <div><span className={s.num}>{counts.skills}</span><span className={s.unit}>{counts.skills === 1 ? 'skill' : 'skills'}</span></div>
          </div>
          {master.data && master.data.issues.length > 0 && (
            <div className={s.flag}>
              {master.data.issues.length} {master.data.issues.length === 1 ? 'thing' : 'things'} to check on the next screen
            </div>
          )}
        </div>
      )}
    </OnboardFrame>
  )
}
