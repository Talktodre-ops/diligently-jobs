import type { ReactNode } from 'react'
import { Icon } from './Icon'
import s from './Notice.module.css'

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'error' | 'success'; children: ReactNode }) {
  return (
    <div className={`${s.notice} ${s[tone]}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={tone === 'success' ? 'check' : 'alert'} size={18} className={s.icon} />
      <div>{children}</div>
    </div>
  )
}
