import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router'
import s from './Button.module.css'

type Variant = 'primary' | 'dark' | 'secondary' | 'quiet' | 'ghost'
type Common = { variant?: Variant; small?: boolean; block?: boolean; iconOnly?: boolean; children: ReactNode }

function cls({ variant = 'primary', small, block, iconOnly }: Omit<Common, 'children'>, extra?: string) {
  return [s.button, s[variant], small && s.small, block && s.block, iconOnly && s.icon, extra].filter(Boolean).join(' ')
}

type ButtonProps = Common & ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }

/** A real <button>. `busy` disables it and shows a spinner beside the label. */
export function Button({ variant, small, block, iconOnly, busy, children, className, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cls({ variant, small, block, iconOnly }, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <span className={s.spinner} aria-hidden="true" />}
      {children}
    </button>
  )
}

/** A link styled as a button, for navigation. */
export function ButtonLink({ variant, small, block, iconOnly, children, className, ...rest }: Common & LinkProps) {
  return (
    <Link className={cls({ variant, small, block, iconOnly }, className)} {...rest}>
      {children}
    </Link>
  )
}
