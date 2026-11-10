/**
 * LocalSend Protocol v2.2 — a dependency-free Node implementation.
 *
 * This module implements the three pieces a headless LocalSend member needs:
 *
 *   - `discoverDevices`   multicast/HTTP discovery of other devices on the LAN
 *   - `sendFiles`         the Upload API (prepare-upload -> upload -> cancel)
 *   - `LocalSendReceiver` a full HTTPS receiver (register/info/prepare/upload)
 *
 * It is deliberately free of DeepSeek Harness imports so it can be unit-tested
 * in a plain Node process and reused by any other host if needed.
 *
 * Protocol reference: https://github.com/localsend/protocol
 */
import dgram from 'node:dgram'
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const DEFAULT_PORT = 53317
export const MULTICAST_GROUP = '224.0.0.167'
export const MULTICAST_PORT = 53317
export const PROTOCOL_VERSION = '2.0'
export const API_PREFIX = '/api/localsend/v2'

/** A LocalSend member info object (used in announces and upload requests). */
export function makeInfo({
  alias,
  port = DEFAULT_PORT,
  protocol = 'https',
  deviceType = 'desktop',
  deviceModel = null,
  fingerprint = '',
  download = false,
}) {
  return {
    alias,
    version: PROTOCOL_VERSION,
    deviceModel,
    deviceType,
    fingerprint,
    port,
    protocol,
    download,
  }
}

/** SHA-256 of a PEM certificate's DER encoding — LocalSend's HTTPS fingerprint. */
export function fingerprintFromCert(certPem) {
  const cert = new crypto.X509Certificate(certPem)
  return crypto.createHash('sha256').update(cert.raw).digest('hex')
}

/* ------------------------------------------------------------------ *
 *  Self-signed identity certificate (pure Node, no external tools).   *
 *  Every machine generates its own key/cert on first use and caches   *
 *  it under ~/.localsend-dsh/certs, so each install gets a unique,    *
 *  stable LocalSend fingerprint and no private key is ever shipped.   *
 * ------------------------------------------------------------------ */

/* Minimal ASN.1 DER encoding helpers for a self-signed X.509 v3 cert. */

function derLength(len) {
  if (len < 0x80) return Buffer.from([len])
  const bytes = []
  let n = len
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n = Math.floor(n / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function der(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content)
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

/** INTEGER from big-endian unsigned bytes; a leading 0x00 keeps it positive. */
function derInt(bytes) {
  let body = Buffer.from(bytes)
  if ((body[0] & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body])
  return der(0x02, body)
}

function derOid(oid) {
  const parts = oid.split('.').map(Number)
  const encoded = [parts[0] * 40 + parts[1]]
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i]
    const bytes = [v & 0x7f]
    v = Math.floor(v / 128)
    while (v > 0) {
      bytes.unshift((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    encoded.push(...bytes)
  }
  return der(0x06, Buffer.from(encoded))
}

function derNull() {
  return Buffer.from([0x05, 0x00])
}

function derUtf8String(str) {
  return der(0x0c, Buffer.from(str, 'utf8'))
}

function derBitString(buf) {
  return der(0x03, Buffer.concat([Buffer.from([0]), buf]))
}

function derSequence(...items) {
  return der(0x30, Buffer.concat(items))
}

function derSet(...items) {
  return der(0x31, Buffer.concat(items))
}

/** UTCTime (YYMMDDHHMMSSZ), valid for 1950–2049. */
function derUtcTime(date) {
  const parts = [
    String(date.getUTCFullYear()).padStart(4, '0').slice(2),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
    String(date.getUTCSeconds()).padStart(2, '0'),
  ]
  return der(0x17, Buffer.from(parts.join('') + 'Z', 'ascii'))
}

const OID_CN = '2.5.4.3'
const OID_SHA256_WITH_RSA = '1.2.840.113549.1.1.11'

function derName(cn) {
  return derSequence(derSet(derSequence(derOid(OID_CN), derUtf8String(cn))))
}

function toPem(label, derBuf) {
  const lines = derBuf.toString('base64').match(/.{1,64}/g)?.join('\n') ?? ''
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`
}

/** Generate a fresh RSA-2048 self-signed certificate without external tools. */
export function generateSelfSignedCert(commonName, { days = 3650 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const serial = crypto.randomBytes(16)

  const version = der(0xa0, derInt([0x02])) // [0] EXPLICIT INTEGER 2 → v3
  const signatureAlgorithm = derSequence(derOid(OID_SHA256_WITH_RSA), derNull())

  const now = new Date()
  const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000) // tolerate clock skew
  const notAfter = new Date(notBefore.getTime() + days * 24 * 60 * 60 * 1000)

  const tbsCertificate = derSequence(
    version,
    derInt(serial),
    signatureAlgorithm,
    derName(commonName),
    derSequence(derUtcTime(notBefore), derUtcTime(notAfter)),
    derName(commonName),
    spki, // `spki` is already the full SubjectPublicKeyInfo (SEQUENCE { OID, NULL, BIT STRING })
  )

  const signature = crypto.sign('sha256', tbsCertificate, privateKey)
  const certificate = derSequence(tbsCertificate, signatureAlgorithm, derBitString(signature))

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: toPem('CERTIFICATE', certificate),
  }
}

/** Directory holding this machine's persistent LocalSend identity. */
export function defaultCertDir() {
  return path.join(os.homedir(), '.localsend-dsh', 'certs')
}

function readCertPair(keyPath, certPath) {
  try {
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) return null
    const key = fs.readFileSync(keyPath, 'utf8')
    const cert = fs.readFileSync(certPath, 'utf8')
    return { key, cert, fingerprint: fingerprintFromCert(cert) }
  } catch {
    return null
  }
}

/**
 * Load this machine's self-signed identity certificate, generating and caching
 * one on first use. The private key never leaves this machine.
 */
export function loadOrCreateCert({ certDir = defaultCertDir() } = {}) {
  const keyPath = path.join(certDir, 'key.pem')
  const certPath = path.join(certDir, 'cert.pem')
  const existing = readCertPair(keyPath, certPath)
  if (existing) return { ...existing, certDir }
  const { key, cert } = generateSelfSignedCert('DeepSeek Harness LocalSend')
  fs.mkdirSync(certDir, { recursive: true })
  fs.writeFileSync(keyPath, key, { mode: 0o600 })
  fs.writeFileSync(certPath, cert, { mode: 0o600 })
  return { key, cert, fingerprint: fingerprintFromCert(cert), certDir }
}

const MIME_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  apk: 'application/vnd.android.package-archive',
  dmg: 'application/x-apple-diskimage',
  exe: 'application/x-msdownload',
}

/** Best-effort MIME type from a file name. LocalSend uses it for previews. */
export function mimeFromName(name) {
  const ext = path.extname(name).slice(1).toLowerCase()
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

/** Strip path separators and traversal from a sender-supplied file name. */
function safeFileName(name) {
  const base = path.basename(String(name ?? 'file'))
  return base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'file'
}

/** Resolve a device record into a base URL (https by default). */
function baseUrlOf(device) {
  const port = Number(device?.port) || DEFAULT_PORT
  const protocol = device?.protocol === 'http' ? 'http' : 'https'
  return `${protocol}://${device.ip}:${port}`
}

/** Perform one JSON request against a LocalSend device, returning raw fields. */
function requestJson(baseUrl, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const secure = baseUrl.startsWith('https://')
    const lib = secure ? https : http
    const target = new URL(urlPath, baseUrl)
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = lib.request(
      target,
      {
        method,
        // `agent: false` forces a direct connection, bypassing Node's
        // `--use-env-proxy` global agent so LAN traffic never hits the proxy.
        agent: false,
        ...(payload
          ? { headers: { 'content-type': 'application/json', 'content-length': payload.length } }
          : {}),
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text.trim() === '' ? null : JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: res.statusCode ?? 0, json, text })
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/** Stream one local file to the receiver's upload endpoint. */
function uploadFileBinary(baseUrl, urlPath, filePath, size) {
  return new Promise((resolve, reject) => {
    const secure = baseUrl.startsWith('https://')
    const lib = secure ? https : http
    const target = new URL(urlPath, baseUrl)
    const req = lib.request(
      target,
      {
        method: 'POST',
        headers: { 'content-length': size },
        // Direct connection: see `requestJson` for why `agent: false` matters.
        agent: false,
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      },
    )
    req.on('error', reject)
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.pipe(req)
  })
}

/**
 * Discover LocalSend devices on the LAN.
 *
 * Three mechanisms are combined for reliability:
 *   1. Passive listen on the multicast group for periodic announcements.
 *   2. Send our own `announce: true` datagram to prompt immediate replies.
 *   3. A short-lived HTTP responder for `POST /register` replies (the primary
 *      reply path in the spec); it is skipped silently if the port is taken.
 *
 * @returns {Promise<Array<object>>} deduplicated device records.
 */
export function discoverDevices({ self = null, timeoutMs = 3000, port = DEFAULT_PORT } = {}) {
  const devices = new Map()

  const add = (info, ip) => {
    if (!info || typeof info !== 'object') return
    if (typeof info.alias !== 'string' || info.alias === '') return
    if (self && info.fingerprint && self.fingerprint && info.fingerprint === self.fingerprint) return
    const deviceIp = ip || info.ip
    if (!deviceIp) return
    const devicePort = Number(info.port) || port
    const key = `${deviceIp}:${devicePort}`
    devices.set(key, {
      alias: info.alias,
      ip: deviceIp,
      port: devicePort,
      protocol: info.protocol === 'http' ? 'http' : 'https',
      deviceType: info.deviceType || 'desktop',
      deviceModel: info.deviceModel || null,
      version: info.version || PROTOCOL_VERSION,
      fingerprint: info.fingerprint || '',
      download: info.download === true,
    })
  }

  return new Promise((resolve) => {
    let settled = false
    let udp = null
    let httpServer = null

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        udp?.close()
      } catch {}
      try {
        httpServer?.close()
      } catch {}
      resolve([...devices.values()])
    }
    const timer = setTimeout(finish, timeoutMs)

    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    udp.on('message', (msg, rinfo) => {
      let data
      try {
        data = JSON.parse(msg.toString('utf8'))
      } catch {
        return
      }
      add(data, rinfo.address)
    })
    udp.on('error', () => {})
    udp.bind(port, () => {
      try {
        udp.setMulticastTTL(1)
        udp.setMulticastLoopback(false)
        udp.addMembership(MULTICAST_GROUP)
      } catch {}
      if (self) {
        const buf = Buffer.from(JSON.stringify({ ...self, announce: true }))
        udp.send(buf, MULTICAST_PORT, MULTICAST_GROUP, () => {})
      }
    })

    if (self) {
      httpServer = http.createServer((req, res) => {
        const route = new URL(req.url, 'http://localhost').pathname
        if (req.method === 'POST' && route === `${API_PREFIX}/register`) {
          let body = ''
          req.on('data', (chunk) => (body += chunk))
          req.on('end', () => {
            let data = null
            try {
              data = JSON.parse(body)
            } catch {}
            if (data) add(data, req.socket.remoteAddress)
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(self))
          })
          return
        }
        if (req.method === 'GET' && route === `${API_PREFIX}/info`) {
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(self))
          return
        }
        res.statusCode = 404
        res.end()
      })
      httpServer.on('error', () => {})
      httpServer.listen(port, '0.0.0.0', () => {})
    }
  })
}

/**
 * Send one or more files to a discovered LocalSend device.
 *
 * @param {object}   opts
 * @param {object}   opts.device   a discovered device record (`ip`, `port`, `protocol`, `alias`)
 * @param {string[]} opts.files    absolute (or resolvable) paths to send
 * @param {string}   [opts.pin]    receiver PIN, if required
 * @param {object}   [opts.self]   our own info object to embed in the request
 */
export async function sendFiles({ device, files, pin, self }) {
  if (!device || !device.ip) throw new Error('a device with an ip address is required')
  const baseUrl = baseUrlOf(device)

  const metas = {}
  const order = []
  let index = 0
  for (const file of files) {
    const abs = path.resolve(file)
    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat || !stat.isFile()) throw new Error(`not a regular file: ${file}`)
    const id = `file-${index++}`
    const fileName = path.basename(abs)
    metas[id] = {
      id,
      fileName,
      size: stat.size,
      fileType: mimeFromName(fileName),
      sha256: null,
      preview: null,
      metadata: { modified: stat.mtime.toISOString(), accessed: null },
    }
    order.push({ id, abs, fileName, size: stat.size })
  }
  if (order.length === 0) throw new Error('no files to send')

  const pinQuery = pin ? `?pin=${encodeURIComponent(pin)}` : ''
  const prep = await requestJson(baseUrl, 'POST', `${API_PREFIX}/prepare-upload${pinQuery}`, {
    info: self ?? {},
    files: metas,
  })

  if (prep.status === 204) {
    return { ok: true, sessionId: null, sent: [], note: 'receiver reported finished (no transfer needed)' }
  }
  if (prep.status === 401) throw new Error('PIN required or invalid PIN')
  if (prep.status === 403) throw new Error('receiver rejected the transfer')
  if (prep.status === 409) throw new Error('receiver is busy with another session')
  if (prep.status === 429) throw new Error('receiver is rate-limiting requests')
  if (prep.status !== 200 || !prep.json || !prep.json.sessionId) {
    throw new Error(`prepare-upload failed (HTTP ${prep.status}): ${prep.text || 'no session id'}`)
  }

  const sessionId = prep.json.sessionId
  const tokens = prep.json.files ?? {}
  const sent = []
  try {
    for (const { id, abs, fileName, size } of order) {
      const token = tokens[id]
      if (!token) continue // the receiver declined this specific file
      const query = `?sessionId=${encodeURIComponent(sessionId)}&fileId=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`
      const up = await uploadFileBinary(baseUrl, `${API_PREFIX}/upload${query}`, abs, size)
      if (up.status !== 200 && up.status !== 204) {
        throw new Error(`upload of "${fileName}" failed (HTTP ${up.status})`)
      }
      sent.push(fileName)
    }
  } catch (error) {
    await requestJson(baseUrl, 'POST', `${API_PREFIX}/cancel?sessionId=${encodeURIComponent(sessionId)}`).catch(() => {})
    throw error
  }

  return { ok: true, sessionId, sent, receiver: device.alias }
}

/**
 * Open the operating system's native file picker and return the selected
 * absolute paths. macOS (osascript), Windows (PowerShell OpenFileDialog) and
 * Linux (zenity) are supported; an empty array means the user cancelled or no
 * native picker is available on this platform.
 */
export function pickFiles({ multiple = true } = {}) {
  if (process.platform === 'darwin') return pickFilesDarwin(multiple)
  if (process.platform === 'win32') return pickFilesWindows(multiple)
  return pickFilesLinux(multiple)
}

function pickFilesDarwin(multiple) {
  return new Promise((resolve) => {
    const script = [
      multiple ? 'set fs to choose file with multiple selections allowed' : 'set fs to {choose file}',
      'set out to ""',
      'repeat with f in fs',
      '  set out to out & (POSIX path of f) & linefeed',
      'end repeat',
      'return out',
    ].join('\n')
    const file = path.join(os.tmpdir(), `localsend-pick-${process.pid}-${Date.now()}.applescript`)
    fs.writeFileSync(file, script, 'utf8')
    const child = spawn('osascript', [file])
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.on('close', (code) => {
      try {
        fs.unlinkSync(file)
      } catch {}
      if (code !== 0) return resolve([]) // cancelled or unavailable
      resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
    })
    child.on('error', () => {
      try {
        fs.unlinkSync(file)
      } catch {}
      resolve([])
    })
  })
}

function pickFilesWindows(multiple) {
  return new Promise((resolve) => {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      `$d.Multiselect = ${multiple ? '$true' : '$false'}`,
      "if ($d.ShowDialog() -eq 'OK') { $d.FileNames }",
    ].join('; ')
    const child = spawn('powershell', ['-NoProfile', '-Command', script])
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.on('close', (code) => {
      if (code !== 0) return resolve([])
      resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
    })
    child.on('error', () => resolve([]))
  })
}

function pickFilesLinux(multiple) {
  return new Promise((resolve) => {
    const args = multiple ? ['--file-selection', '--multiple', '--separator=\n'] : ['--file-selection']
    const child = spawn('zenity', args)
    let stdout = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.on('close', (code) => {
      if (code !== 0) return resolve([])
      resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
    })
    child.on('error', () => resolve([]))
  })
}

/**
 * Ask the OS file manager to open a file or its containing folder.
 * @param {string} target absolute path of the file.
 * @param {'open'|'reveal'} [mode] open the target, or reveal it (selected in its folder).
 */
export function openInFileManager(target, mode = 'open') {
  let command
  let args
  if (process.platform === 'darwin') {
    command = 'open'
    // `open <dir>` shows the directory; `open -R <file>` shows it selected in Finder.
    args = mode === 'reveal' ? ['-R', target] : [target]
  } else if (process.platform === 'win32') {
    command = 'explorer.exe'
    args = mode === 'reveal' ? [`/select,${target}`] : [target]
  } else {
    command = 'xdg-open'
    args = [target]
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

/**
 * A full LocalSend HTTPS receiver: announces itself on the LAN and accepts
 * uploads into a local folder. Phones / desktops see it as a normal device.
 */
export class LocalSendReceiver {
  constructor({
    alias = 'DeepSeek Harness',
    port = DEFAULT_PORT,
    destination,
    deviceType = 'desktop',
    deviceModel = null,
    key,
    cert,
  }) {
    if (!destination) throw new Error('a destination directory is required')
    if (!key || !cert) throw new Error('a key and certificate are required')
    this.alias = alias
    this.port = port
    this.destination = destination
    this.deviceType = deviceType
    this.deviceModel = deviceModel
    this.key = key
    this.cert = cert
    this.fingerprint = fingerprintFromCert(cert)
    this.server = null
    this.udp = null
    this.announceTimer = null
    this.actualPort = port
    this.running = false
    this.sessions = new Map()
    this.received = []
  }

  info() {
    return makeInfo({
      alias: this.alias,
      port: this.actualPort,
      protocol: 'https',
      deviceType: this.deviceType,
      deviceModel: this.deviceModel,
      fingerprint: this.fingerprint,
      download: false,
    })
  }

  status() {
    return {
      running: this.running,
      alias: this.alias,
      port: this.actualPort,
      fingerprint: this.fingerprint,
      destination: this.destination,
      receivedCount: this.received.length,
    }
  }

  async start({ allowEphemeralFallback = false } = {}) {
    await fsp.mkdir(this.destination, { recursive: true })
    try {
      await this.listen(this.port)
    } catch (error) {
      if (allowEphemeralFallback && error?.code === 'EADDRINUSE') {
        console.warn(`[localsend] port ${this.port} is in use; receiver bound to an ephemeral port instead`)
        await this.listen(0)
      } else {
        throw error
      }
    }
    this.running = true
    this.startAnnounce()
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = https.createServer({ key: this.key, cert: this.cert }, (req, res) => this.handle(req, res))
      server.on('error', reject)
      server.listen(port, '0.0.0.0', () => {
        const addr = server.address()
        this.actualPort = typeof addr === 'object' && addr ? addr.port : port
        resolve()
      })
      this.server = server
    })
  }

  startAnnounce() {
    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.udp.on('error', () => {})
    this.udp.bind(this.actualPort, () => {
      try {
        this.udp.setMulticastTTL(1)
        this.udp.setMulticastLoopback(false)
        this.udp.addMembership(MULTICAST_GROUP)
      } catch {}
      const send = () => {
        if (!this.running) return
        const buf = Buffer.from(JSON.stringify({ ...this.info(), announce: true }))
        this.udp.send(buf, MULTICAST_PORT, MULTICAST_GROUP, () => {})
      }
      send()
      this.announceTimer = setInterval(send, 2000)
    })
  }

  async stop() {
    this.running = false
    if (this.announceTimer) clearInterval(this.announceTimer)
    this.announceTimer = null
    try {
      this.udp?.close()
    } catch {}
    this.udp = null
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()))
      this.server = null
    }
    this.sessions.clear()
  }

  async handle(req, res) {
    const route = new URL(req.url, 'https://localhost').pathname
    try {
      if (req.method === 'POST' && route === `${API_PREFIX}/register`) return this.handleRegister(req, res)
      if (req.method === 'GET' && route === `${API_PREFIX}/info`) return this.json(res, 200, this.info())
      if (req.method === 'POST' && route === `${API_PREFIX}/prepare-upload`) return this.handlePrepareUpload(req, res)
      if (req.method === 'POST' && route === `${API_PREFIX}/upload`) return this.handleUpload(req, res)
      if (req.method === 'POST' && route === `${API_PREFIX}/cancel`) return this.handleCancel(req, res)
      this.json(res, 404, { code: 'not-found' })
    } catch (error) {
      console.error('[localsend] receiver error', error)
      this.json(res, 500, { code: 'internal' })
    }
  }

  async handleRegister(req, res) {
    await readBody(req, 64 * 1024) // we do not need the content; announce is enough
    this.json(res, 200, this.info())
  }

  async handlePrepareUpload(req, res) {
    const body = await readJsonBody(req)
    const senderAlias = body?.info?.alias || null
    const entries = Array.isArray(body?.files)
      ? body.files
      : Object.values(body?.files ?? {})

    if (!Array.isArray(entries) || entries.length === 0) {
      return this.json(res, 400, { code: 'invalid-body', message: 'no files' })
    }

    const sessionId = crypto.randomUUID()
    const files = new Map()
    const usedNames = new Map()

    for (const entry of entries) {
      const id = typeof entry?.id === 'string' ? entry.id : crypto.randomUUID()
      const token = crypto.randomUUID()
      const base = safeFileName(entry?.fileName)
      const collisions = usedNames.get(base) ?? 0
      usedNames.set(base, collisions + 1)
      const fileName = collisions === 0 ? base : `${path.parse(base).name}-${collisions}${path.parse(base).ext}`
      files.set(id, {
        token,
        fileName,
        size: Number(entry?.size) || 0,
        sha256: typeof entry?.sha256 === 'string' ? entry.sha256 : null,
        dest: path.join(this.destination, safeFileName(fileName)),
        senderAlias,
        saved: null,
      })
    }

    this.sessions.set(sessionId, { files, senderAlias })
    this.json(res, 200, {
      sessionId,
      files: Object.fromEntries([...files.entries()].map(([id, f]) => [id, f.token])),
    })
  }

  async handleUpload(req, res) {
    const url = new URL(req.url, 'https://localhost')
    const sessionId = url.searchParams.get('sessionId')
    const fileId = url.searchParams.get('fileId')
    const token = url.searchParams.get('token')
    const session = this.sessions.get(sessionId)
    const file = session?.files.get(fileId)
    if (!session || !file || file.token !== token) {
      return this.json(res, 403, { code: 'invalid-token', message: 'invalid token' })
    }
    if (file.saved) {
      return this.json(res, 409, { code: 'blocked', message: 'already received' })
    }

    let digest
    try {
      digest = await writeToFile(req, file.dest)
    } catch (error) {
      console.error('[localsend] write failed', error)
      return this.json(res, 500, { code: 'internal', message: 'write failed' })
    }

    if (file.sha256 && digest.toLowerCase() !== file.sha256.toLowerCase()) {
      await fsp.rm(file.dest, { force: true }).catch(() => {})
      return this.json(res, 422, { code: 'checksum-mismatch', message: 'sha256 mismatch' })
    }

    file.saved = { path: file.dest, size: file.size, sha256: digest }
    this.received.push({ from: file.senderAlias, fileName: file.fileName, path: file.dest, size: file.size, at: new Date().toISOString() })
    res.statusCode = 200
    res.end()
  }

  async handleCancel(req, res) {
    const url = new URL(req.url, 'https://localhost')
    const sessionId = url.searchParams.get('sessionId')
    this.sessions.delete(sessionId)
    res.statusCode = 200
    res.end()
  }

  json(res, status, payload) {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }
}

/** Stream a request body to disk while hashing it; resolves to the sha256 hex. */
function writeToFile(req, dest) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const ws = fs.createWriteStream(dest)
    req.on('data', (chunk) => hash.update(chunk))
    ws.on('finish', () => resolve(hash.digest('hex')))
    ws.on('error', reject)
    req.on('error', reject)
    req.pipe(ws)
  })
}

/** Read and parse a JSON request body, capped to avoid unbounded buffering. */
async function readJsonBody(req, limit = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > limit) {
      req.resume()
      throw new Error('request body too large')
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks, size).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/** Read and discard a request body, capped. */
async function readBody(req, limit = 8 * 1024 * 1024) {
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > limit) {
      req.resume()
      throw new Error('request body too large')
    }
  }
}
