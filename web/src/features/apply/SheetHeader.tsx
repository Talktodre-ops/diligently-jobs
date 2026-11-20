import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Icon } from '../../ui/Icon'
import s from './SheetHeader.module.css'

/** Header for a modal-like step (New job, Running): a quiet title and a close link. */
export function SheetHeader({ title, close = '/', closeLabel = 'Close' }: { title: ReactNode; close?: string; closeLabel?: string }) {
  return (
    <header className={s.bar}>
      <div className={s.title}>{title}</div>
      <Link to={close} className={s.close} aria-label={closeLabel}>
        <Icon name="close" size={22} strokeWidth={2} />
      </Link>
    </header>
  )
}
