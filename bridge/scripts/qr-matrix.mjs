// Print a QR matrix as rows of 0/1 (used by CI to cross-check the encoder with CoreImage).
import { encodeQr } from '../src/qr.js'
const text = process.argv[2]
const level = process.argv[3] ?? 'M'
const { modules } = encodeQr(text, level)
process.stdout.write(modules.map(row => row.map(v => (v ? '1' : '0')).join('')).join('\n') + '\n')
