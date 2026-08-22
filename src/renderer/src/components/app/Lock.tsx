import { Logo } from '@/components/app/Logo'
import { Lattice } from '@/components/app/Lattice'
import { LicenseForm } from '@/components/app/LicenseForm'
import { PRODUCT } from '@shared/product'
import type { LicenseState } from '@shared/license'

const REASON: Record<Extract<LicenseState, { state: 'expired' }>['reason'], string> = {
  trial: 'Your 7-day trial has ended.',
  license: 'Your license key has expired or is not valid for this build.',
  clock: 'The system clock moved backwards. Fix the clock, or enter a license key.'
}

/** Replaces the whole window once the trial is over. Nothing else is reachable. */
export function Lock({ reason }: { reason: keyof typeof REASON }): React.JSX.Element {
  return (
    <div className="relative flex h-full items-center justify-center p-8">
      <Lattice className="absolute inset-0 size-full [mask-image:radial-gradient(ellipse_at_center,transparent_20%,black_80%)]" />
      <div className="stagger elev relative w-full max-w-md rounded-xl border bg-card p-6">
        <Logo size={40} />
        <h1 className="hero-title mt-5 text-2xl">
          {PRODUCT} is <span className="text-lemon-ink">locked</span>.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{REASON[reason]}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Your workspace, receipts and history are still on this machine and come back the moment a
          key is entered.
        </p>
        <div className="mt-5">
          <LicenseForm />
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          Get a key at{' '}
          <a
            href="https://theplumbr.com"
            target="_blank"
            rel="noreferrer"
            className="text-lemon-ink underline-offset-2 hover:underline"
          >
            theplumbr.com
          </a>
          .
        </p>
      </div>
    </div>
  )
}
