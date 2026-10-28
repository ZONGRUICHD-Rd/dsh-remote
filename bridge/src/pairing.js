// Short-lived 6-digit pairing codes. A code is shown on the PC (admin page,
// QR code, /remote command) and exchanged once by a phone for a device token.
import { randomInt } from 'node:crypto'
import { safeEqual } from './util.js'

export class PairingCodes {
  constructor({ ttlMs = 10 * 60 * 1000, maxAttempts = 5 } = {}) {
    this.ttlMs = ttlMs
    this.maxAttempts = maxAttempts
    this.current = undefined
  }

  /** Current code, minting a new one when absent, expired, or exhausted. */
  get() {
    const now = Date.now()
    if (!this.current || now >= this.current.expiresAt || this.current.attempts >= this.maxAttempts) {
      this.current = {
        code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
        expiresAt: now + this.ttlMs,
        attempts: 0,
      }
    }
    return { code: this.current.code, expiresAt: this.current.expiresAt }
  }

  regenerate() {
    this.current = undefined
    return this.get()
  }

  /** Consume the code when it matches; every miss counts toward exhaustion. */
  consume(candidate) {
    const now = Date.now()
    const current = this.current
    if (!current || now >= current.expiresAt || current.attempts >= this.maxAttempts) return false
    if (typeof candidate === 'string' && safeEqual(candidate.trim(), current.code)) {
      this.current = undefined
      return true
    }
    current.attempts += 1
    return false
  }
}
