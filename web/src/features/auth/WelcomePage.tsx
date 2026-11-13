import { useLocation } from 'react-router'
import { ButtonLink } from '../../ui/Button'
import { BrandArt } from './components/BrandArt'
import s from './WelcomePage.module.css'

export default function WelcomePage() {
  const { state } = useLocation()
  return (
    <div className={s.page}>
      <div className={s.wordmark}>
        diligently<span className={s.dot}>.</span>
      </div>
      <div className={s.art}>
        <BrandArt />
      </div>
      <div className={s.copy}>
        <h1 className={s.title}>Apply from anywhere.</h1>
        <p className={s.lede}>Paste a job. Get a tailored CV, a match score and a cover letter, ready to send from your phone.</p>
      </div>
      <div className={s.actions}>
        <ButtonLink to="/signup" state={state} block>Create an account</ButtonLink>
        <ButtonLink to="/signin" state={state} variant="secondary" block className={s.outline}>I have an account</ButtonLink>
      </div>
    </div>
  )
}
