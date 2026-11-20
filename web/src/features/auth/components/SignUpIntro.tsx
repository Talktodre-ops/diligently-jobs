import s from './SignUpIntro.module.css'

/** The promise on sign up: aubergine band on a phone, the side panel on wider screens. */
export function SignUpIntro() {
  return (
    <div className={s.intro}>
      <h1 className={s.promise}>Your first tailored CV is about four minutes away.</h1>
      <ol className={s.steps}>
        <li><span className={s.num} aria-hidden="true">1</span>Bring your CV, any format</li>
        <li><span className={s.num} aria-hidden="true">2</span>Tell us what you are after</li>
        <li><span className={s.num} aria-hidden="true">3</span>Paste a job, get a CV made for it</li>
      </ol>
    </div>
  )
}
