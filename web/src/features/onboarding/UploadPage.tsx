import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { profileKey, useMe, useProfile } from '../../auth/session'
import { Button } from '../../ui/Button'
import { Icon } from '../../ui/Icon'
import { Notice } from '../../ui/Notice'
import { TextArea, TextField } from '../../ui/TextField'
import { DESKTOP, useMediaQuery } from '../../ui/useMediaQuery'
import { toFormError } from '../auth/errors'
import {
  fileProblem, masterKey, MIN_PASTE_CHARS, pastedFile, useMaster, useSaveMaster, useStartUpload, useUpdateProfile, useUpload,
} from './api'
import { CvEmpty, CvSheet } from './components/CvSheet'
import { OnboardFrame } from './components/OnboardFrame'
import { foundFacts } from './cvFacts'
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

/** Staged status while the reader works. The API only says queued or reading, so these follow the clock and never claim to be finished. */
function stage(seconds: number) {
  if (seconds < 3) return 'Opening the file'
  if (seconds < 10) return 'Reading your roles'
  if (seconds < 20) return 'Collecting skills and education'
  return 'Almost done'
}

const REVEAL_MS = 450
type Mode = 'choose' | 'paste' | 'hand'

export default function UploadPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const me = useMe()
  const profile = useProfile(!!me.data?.email_verified)
  const master = useMaster()
  const start = useStartUpload()
  const saveMaster = useSaveMaster()
  const updateProfile = useUpdateProfile()
  const desktop = useMediaQuery(DESKTOP)
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

  const [uploadId, setUploadId] = useState<string | null>(remembered)
  const [since, setSince] = useState<number | null>(null)
  const [now, setNow] = useState(0)
  const [chosen, setChosen] = useState<string | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('choose')
  const [liOpen, setLiOpen] = useState(false)
  const [paste, setPaste] = useState('')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [shown, setShown] = useState(0)
  const [nextError, setNextError] = useState<string | null>(null)
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
      void qc.invalidateQueries({ queryKey: masterKey })
    }
  }, [status, qc])

  const reading = start.isPending || (!!uploadId && !lost && (!upload.data || status === 'queued' || status === 'reading' || (status === 'done' && !master.data)))
  const failed = !!uploadId && !lost && status === 'failed'
  const hasCv = !!master.data && !reading && !failed && !replacing
  // Only a read we watched gets the line-by-line reveal; a CV that was already saved shows at once.
  const justRead = hasCv && status === 'done' && !reduceMotion
  const facts = hasCv && master.data ? foundFacts(master.data.doc) : []
  const visible = justRead ? Math.min(shown, facts.length) : facts.length

  useEffect(() => {
    if (!reading) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [reading])

  useEffect(() => {
    if (!justRead || shown >= facts.length) return
    const t = setTimeout(() => setShown((n) => n + 1), REVEAL_MS)
    return () => clearTimeout(t)
  }, [justRead, shown, facts.length])

  function send(file: File, onFail: (message: string) => void) {
    setChosen(file.name)
    setSince(Date.now())
    setNow(Date.now())
    setShown(0)
    start.mutate(file, {
      onSuccess: ({ upload: u }) => {
        remember(u.id)
        setUploadId(u.id)
        setReplacing(false)
        setMode('choose')
      },
      onError: (err) => onFail(toFormError(err, 'file').message),
    })
  }

  function choose(file: File | undefined) {
    if (!file) return
    const p = fileProblem(file)
    setProblem(p)
    if (!p) send(file, setProblem)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    choose(e.dataTransfer.files[0])
  }

  function readPasted(e: FormEvent) {
    e.preventDefault()
    if (paste.trim().length < MIN_PASTE_CHARS) {
      setPasteError('That looks short for a CV. Paste all of it, from your name down to your education.')
      return
    }
    setPasteError(null)
    send(pastedFile(paste), setPasteError)
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

  async function next() {
    setNextError(null)
    try {
      // A finished upload already moves the step on; this covers a CV saved some other way.
      if (profile.data?.onboarding_step === 'upload') await updateProfile.mutateAsync({ onboarding_step: 'check' })
      navigate('/onboarding/check')
    } catch (err) {
      setNextError(toFormError(err).message)
    }
  }

  function replace() {
    setReplacing(true)
    setUploadId(null)
    setSince(null)
    setChosen(null)
    remember(null)
  }

  const seconds = since ? Math.max(0, Math.round((now - since) / 1000)) : 0
  const isTxt = upload.data?.kind === 'txt' || chosen === 'cv.txt'
  const fileName = isTxt ? 'Pasted text' : upload.data?.filename ?? chosen ?? 'Your CV'
  const kind = isTxt ? 'TXT' : (upload.data?.kind ?? chosen?.split('.').pop() ?? 'CV').toUpperCase()
  const statusLine = reading
    ? start.isPending ? 'Uploading' : stage(seconds)
    : justRead ? (since ? `Read in full, ${seconds} seconds` : 'Read in full') : 'Saved to your account'
  const progress = start.isPending ? 6 : Math.min(92, 10 + seconds * 3.5)
  const issues = master.data?.issues.length ?? 0

  const paperEmpty = reading
    ? <CvEmpty title="Reading your CV" body={`${statusLine}. Your name comes first, then each role, then your skills.`} />
    : <CvEmpty title="Your CV appears here as we read it" body="Name first, then each role, then your skills. Usually under 30 seconds." />
  const aside = (
    <CvSheet
      contained
      animate={justRead}
      doc={hasCv && master.data ? master.data.doc : null}
      reveal={justRead ? Math.min(4, visible) : 4}
      empty={paperEmpty}
    />
  )

  return (
    <OnboardFrame
      step="upload"
      aside={aside}
      asideLabel="Your CV as we read it"
      footer={
        hasCv ? (
          <>
            {nextError && <Notice tone="error">{nextError}</Notice>}
            <Button block busy={updateProfile.isPending} onClick={next}>Looks like me, continue</Button>
          </>
        ) : (
          <p className={s.privacy}>Private to your account. Delete it any time.</p>
        )
      }
    >
      <div className={s.heading}>
        <h1 className={s.title}>{hasCv ? 'That is you, right?' : 'Bring your CV'}</h1>
        <p className={s.lede}>
          {hasCv
            ? 'Here is what we read. You can fix anything on the next screen.'
            : 'It becomes your master CV. Every application is tailored from it, and we never add anything that is not on it.'}
        </p>
      </div>

      {!reading && !hasCv && mode === 'choose' && (
        <div className={s.stack}>
          {failed && (
            <Notice tone="error">
              We could not read that. {upload.data?.error ?? 'Try another copy, paste the text, or start from scratch.'}
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
          >
            <span className={s.dropIcon}><Icon name="upload" size={26} strokeWidth={1.8} /></span>
            <span className={s.dropTitle}>{desktop ? 'Drop your CV here, or choose a file' : 'Choose your CV'}</span>
            <span className={s.dropNote}>
              {desktop ? 'PDF or Word, up to 5 MB. A LinkedIn PDF works too.' : 'PDF or Word, up to 5 MB. From your phone, Drive or iCloud.'}
            </span>
          </button>
          {problem && <p className={s.problem} role="alert">{problem}</p>}

          <div className={s.disclosure}>
            <button type="button" className={s.discToggle} aria-expanded={liOpen} aria-controls="li-steps" onClick={() => setLiOpen((v) => !v)}>
              <span className={s.liMark} aria-hidden="true">in</span>
              <span className={s.discLabel}>No CV? Use your LinkedIn profile</span>
              <Icon name="forward" size={18} strokeWidth={2} className={liOpen ? s.chevOpen : s.chev} />
            </button>
            {liOpen && (
              <ol id="li-steps" className={s.liSteps}>
                <li>Open your profile on LinkedIn</li>
                <li>Tap Resources, then Save to PDF</li>
                <li>Come back and choose that file above</li>
              </ol>
            )}
          </div>

          <div className={s.pair}>
            <Button variant="quiet" className={s.alt} onClick={() => { setMode('paste'); setProblem(null) }}>Paste the text</Button>
            <Button variant="quiet" className={s.alt} onClick={() => { setMode('hand'); setProblem(null) }}>Start from scratch</Button>
          </div>
          {replacing && <Button variant="ghost" block onClick={() => setReplacing(false)}>Keep my current CV</Button>}
        </div>
      )}

      {!reading && !hasCv && mode === 'paste' && (
        <form className={s.stack} onSubmit={readPasted} noValidate>
          <TextArea
            label="Your CV as text"
            rows={10}
            className={s.pasteBox}
            placeholder="Copy everything from your CV or LinkedIn profile and paste it here."
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            hint={paste.trim().length > 0 && paste.trim().length < MIN_PASTE_CHARS
              ? `${paste.trim().length} characters so far. A CV is usually much longer.`
              : 'We read it the same way as a file.'}
            error={pasteError}
          />
          <Button type="submit" block>Read it</Button>
          <Button variant="ghost" block onClick={() => { setMode('choose'); setPasteError(null) }}>Upload a file instead</Button>
        </form>
      )}

      {!reading && !hasCv && mode === 'hand' && (
        <form className={s.stack} onSubmit={byHand} noValidate>
          <p className={s.lede}>Start with your name. The next screen asks for your headline, a role and your skills.</p>
          <TextField label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={nameError} />
          <Button type="submit" busy={saveMaster.isPending || updateProfile.isPending} block>Continue</Button>
          <Button variant="ghost" block onClick={() => setMode('choose')}>Upload a file instead</Button>
        </form>
      )}

      {(reading || hasCv) && (
        <div className={s.card}>
          <div className={s.cardRow}>
            <span className={hasCv ? s.tick : s.kind} aria-hidden="true">
              {hasCv ? <Icon name="check" size={22} strokeWidth={2.2} /> : kind}
            </span>
            <div className={s.cardText}>
              <div className={s.fileName}>{hasCv && !justRead && !upload.data ? 'Your master CV' : fileName}</div>
              <div className={s.fileNote} role="status">{statusLine}</div>
            </div>
            {hasCv && <Button variant="ghost" small className={s.replace} onClick={replace}>Replace</Button>}
          </div>
          {reading && (
            <div className={s.track} aria-hidden="true">
              <div className={s.fill} style={{ width: `${progress}%` }} />
            </div>
          )}
          {hasCv && (
            <ul className={s.found} aria-label="What we read">
              {facts.slice(0, visible).map((f) => (
                <li key={f.label} className={justRead ? s.rise : undefined}>
                  <span className={s.factLabel}>{f.label}</span>
                  <span className={s.factValue}>{f.value}</span>
                </li>
              ))}
            </ul>
          )}
          {hasCv && visible >= facts.length && issues > 0 && (
            <div className={s.flag}>{issues} {issues === 1 ? 'thing' : 'things'} to check on the next screen</div>
          )}
        </div>
      )}
    </OnboardFrame>
  )
}
