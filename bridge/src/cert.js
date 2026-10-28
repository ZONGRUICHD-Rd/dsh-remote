// Self-signed ECDSA P-256 certificate generation with a tiny DER encoder.
// The app never relies on a CA: it pins the SHA-256 fingerprint of this
// certificate, which it learns from the pairing QR code.
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function encodeLength(length) {
  if (length < 0x80) return Buffer.from([length])
  const bytes = []
  while (length > 0) {
    bytes.unshift(length & 0xff)
    length >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag, ...contents) {
  const body = Buffer.concat(contents)
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body])
}

const seq = (...items) => tlv(0x30, ...items)
const set = (...items) => tlv(0x31, ...items)
const explicit = (n, ...items) => tlv(0xa0 + n, ...items)
const octets = buf => tlv(0x04, buf)
const bitString = buf => tlv(0x03, Buffer.from([0]), buf)
const utf8 = text => tlv(0x0c, Buffer.from(text, 'utf8'))
const bool = value => tlv(0x01, Buffer.from([value ? 0xff : 0]))

function integer(buf) {
  let bytes = Buffer.from(buf)
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) bytes = bytes.subarray(1)
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes])
  return tlv(0x02, bytes)
}

function oid(text) {
  const parts = text.split('.').map(Number)
  const out = [parts[0] * 40 + parts[1]]
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f]
    let rest = part >>> 7
    while (rest > 0) {
      chunk.unshift((rest & 0x7f) | 0x80)
      rest >>>= 7
    }
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

function time(date) {
  const pad = n => String(n).padStart(2, '0')
  const y = date.getUTCFullYear()
  const body = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  // RFC 5280: UTCTime through 2049, GeneralizedTime afterwards.
  return y < 2050 ? tlv(0x17, Buffer.from(String(y).slice(2) + body)) : tlv(0x18, Buffer.from(String(y) + body))
}

function ipBytes(ip) {
  if (ip.includes(':')) return null
  const parts = ip.split('.').map(Number)
  return parts.length === 4 && parts.every(n => n >= 0 && n <= 255) ? Buffer.from(parts) : null
}

/**
 * Create a self-signed TLS server certificate.
 * @param {{ commonName: string, dnsNames?: string[], ipAddresses?: string[], days?: number }} options
 * @returns {{ certPem: string, keyPem: string }}
 */
export function createSelfSignedCertificate({ commonName, dnsNames = [], ipAddresses = [], days = 3650 }) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const ecdsaWithSha256 = seq(oid('1.2.840.10045.4.3.2'))
  const name = seq(set(seq(oid('2.5.4.3'), utf8(commonName))), set(seq(oid('2.5.4.10'), utf8('DSH Remote'))))
  const notBefore = new Date(Date.now() - 24 * 3600 * 1000)
  const notAfter = new Date(Date.now() + days * 24 * 3600 * 1000)
  const serial = randomBytes(16)
  serial[0] &= 0x7f

  const altNames = [
    ...new Set(['localhost', ...dnsNames].filter(Boolean)),
  ].map(dns => tlv(0x82, Buffer.from(dns, 'ascii')))
  for (const ip of new Set(['127.0.0.1', ...ipAddresses])) {
    const bytes = ipBytes(ip)
    if (bytes) altNames.push(tlv(0x87, bytes))
  }
  const extensions = explicit(3, seq(
    seq(oid('2.5.29.19'), bool(true), octets(seq())), // basicConstraints CA:FALSE (critical)
    seq(oid('2.5.29.15'), bool(true), octets(tlv(0x03, Buffer.from([0x07, 0x80])))), // keyUsage digitalSignature
    seq(oid('2.5.29.37'), octets(seq(oid('1.3.6.1.5.5.7.3.1')))), // extKeyUsage serverAuth
    seq(oid('2.5.29.17'), octets(seq(...altNames))), // subjectAltName
  ))
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ecdsaWithSha256,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    spki,
    extensions,
  )
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })
  const der = seq(tbs, ecdsaWithSha256, bitString(signature))
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  return { certPem, keyPem }
}

/** Lowercase hex SHA-256 of the certificate's DER encoding (what the app pins). */
export function certificateFingerprint(certPem) {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex')
}

/**
 * Load the bridge certificate from `dir`, creating it on first use. A
 * certificate that no longer parses, does not match its key, or expires
 * within 30 days is replaced (phones then need to pair again).
 */
export async function loadOrCreateCertificate(dir, commonName) {
  const certFile = join(dir, 'cert.pem')
  const keyFile = join(dir, 'key.pem')
  try {
    const [certPem, keyPem] = await Promise.all([readFile(certFile, 'utf8'), readFile(keyFile, 'utf8')])
    const cert = new X509Certificate(certPem)
    const fresh = Date.parse(cert.validTo) - Date.now() > 30 * 24 * 3600 * 1000
    if (fresh && cert.checkPrivateKey(createPrivateKey(keyPem))) {
      return { certPem, keyPem, fingerprint: certificateFingerprint(certPem), created: false }
    }
  } catch {
    // Missing, unreadable, or corrupt material is regenerated below.
  }
  const { certPem, keyPem } = createSelfSignedCertificate({ commonName })
  await mkdir(dir, { recursive: true })
  await writeFile(keyFile, keyPem, { mode: 0o600 })
  await writeFile(certFile, certPem)
  return { certPem, keyPem, fingerprint: certificateFingerprint(certPem), created: true }
}
