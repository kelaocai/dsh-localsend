/**
 * LocalSend — host half of the DSH plugin.
 *
 * One agent tool (`localsend`) plus the same-origin routes the sidebar panel
 * uses. Both entry points share one `LocalSendReceiver` instance, so the panel
 * and the agent control the same receiver:
 *
 *   GET  /localsend/receiver         receiver state (running / port / received)
 *   GET  /localsend/devices          a fresh LAN discovery pass
 *   POST /localsend/receiver/start   start the receiver
 *   POST /localsend/receiver/stop    stop the receiver
 *   POST /localsend/send             send host files to a device
 *   POST /localsend/pick-files       native OS file picker -> absolute paths
 *   POST /localsend/stage            stage dragged-in bytes -> one host path
 *
 * Every route asks the composition's `connection` service for a rejection
 * first, so the Host/Origin fence and the browser login cookie gate each call.
 */
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createWriteStream } from 'node:fs'
import { promises as fsp } from 'node:fs'
import {
  DEFAULT_PORT,
  discoverDevices,
  defaultCertDir,
  loadOrCreateCert,
  LocalSendReceiver,
  makeInfo,
  openInFileManager,
  pickFiles,
  sendFiles,
} from './protocol.js'

/** Cordis plugin name. */
export const name = 'localsend'

/** Routes need the web carrier and trust fence; the tool needs the registry. */
export const inject = ['webServer', 'connection', 'tools']

const TOOL_NAME = 'localsend'
const MAX_BODY_BYTES = 8 * 1024 * 1024

function normalizeConfig(config = {}) {
  const certDir =
    typeof config?.certDir === 'string' && config.certDir !== ''
      ? config.certDir
      : defaultCertDir()
  const cert = loadOrCreateCert({ certDir })
  return {
    alias: typeof config?.alias === 'string' && config.alias !== '' ? config.alias : 'DeepSeek Harness',
    port: Number(config?.port) > 0 ? Number(config.port) : DEFAULT_PORT,
    deviceType: typeof config?.deviceType === 'string' ? config.deviceType : 'desktop',
    deviceModel: typeof config?.deviceModel === 'string' ? config.deviceModel : null,
    destination:
      typeof config?.destination === 'string' && config.destination !== ''
        ? config.destination
        : path.join(process.env.DSH_HOME || os.homedir(), 'localsend-received'),
    fingerprint: cert.fingerprint,
    cert,
  }
}

function selfInfo(cfg) {
  return makeInfo({
    alias: cfg.alias,
    port: cfg.port,
    protocol: 'https',
    deviceType: cfg.deviceType,
    deviceModel: cfg.deviceModel,
    fingerprint: cfg.fingerprint,
    download: false,
  })
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req, limit = MAX_BODY_BYTES) {
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

function streamToFile(req, dest) {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(dest)
    ws.on('finish', resolve)
    ws.on('error', reject)
    req.on('error', reject)
    req.pipe(ws)
  })
}

function formatDevice(d) {
  const type = d.deviceType || 'desktop'
  return `- ${d.alias}  (${d.ip}:${d.port}, ${d.protocol}, ${type}, fingerprint ${d.fingerprint.slice(0, 12)}…)`
}

function formatReceived(list) {
  if (list.length === 0) return 'No files received yet.'
  return list
    .map((f) => `- ${f.fileName}  (${f.size} bytes, from ${f.from ?? 'unknown'})  ${f.path}`)
    .join('\n')
}

function formatStatus(receiver) {
  const s = receiver.status()
  return `Receiver: ${s.running ? 'running' : 'stopped'}\n- alias: ${s.alias}\n- port: ${s.port}\n- fingerprint: ${s.fingerprint.slice(0, 12)}…\n- destination: ${s.destination}\n- received: ${s.receivedCount} file(s)`
}

/** Resolve a user-supplied device reference against a fresh discovery scan. */
async function resolveDevice(reference, cfg) {
  const devices = await discoverDevices({ self: selfInfo(cfg), timeoutMs: 3000 })
  if (devices.length === 0) {
    if (reference) throw new Error(`no devices found on the network; cannot resolve "${reference}"`)
    throw new Error('no devices found on the network')
  }
  if (!reference) {
    throw new Error('a `device` is required when more than one device exists; choose from: ' + devices.map((d) => `${d.alias} (${d.ip}:${d.port})`).join(', '))
  }
  const needle = reference.trim().toLowerCase()
  const byIp = devices.find((d) => `${d.ip}:${d.port}` === needle || d.ip === needle)
  if (byIp) return byIp
  const byAlias = devices.find((d) => d.alias.toLowerCase() === needle)
  if (byAlias) return byAlias
  const byFingerprint = devices.filter((d) => d.fingerprint.toLowerCase().startsWith(needle))
  if (byFingerprint.length === 1) return byFingerprint[0]
  throw new Error(`could not resolve device "${reference}". Found: ${devices.map((d) => `${d.alias} (${d.ip}:${d.port})`).join(', ')}`)
}

function registerRoute(ctx, path, method, handler) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          try {
            const rejection = ctx.connection?.requestRejection?.(req)
            if (rejection !== undefined) {
              res.statusCode = rejection
              res.end()
              return
            }
            if (req.method !== method) {
              res.statusCode = 405
              res.setHeader('allow', method)
              res.end()
              return
            }
            await handler(req, res)
          } catch (error) {
            console.error('[localsend] route failed', error)
            sendJson(res, 500, { code: 'internal', message: 'unexpected failure' })
          }
        },
      }),
    `localsend: ${method} ${path}`,
  )
}

/**
 * Register the panel routes and the agent tool, sharing one receiver.
 * @param {object} ctx Cordis host context carrying `webServer`, `connection`, `tools`.
 * @param {object} [config]
 */
export async function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const stageDir = path.join(os.tmpdir(), 'localsend-stage')
  const staged = new Set()
  let receiver = null

  const cleanupStaged = async (files) => {
    for (const file of files) {
      if (staged.has(file)) {
        staged.delete(file)
        await fsp.rm(file, { force: true }).catch(() => {})
      }
    }
  }

  /** Start (or return) the shared receiver; a busy 53317 falls back to an ephemeral port. */
  const startReceiver = async (opts = {}) => {
    if (receiver?.running) return receiver
    const destination = typeof opts.destination === 'string' && opts.destination !== '' ? opts.destination : cfg.destination
    const alias = typeof opts.alias === 'string' && opts.alias !== '' ? opts.alias : cfg.alias
    const port = Number(opts.port) > 0 ? Number(opts.port) : cfg.port
    const next = new LocalSendReceiver({
      alias,
      port,
      destination,
      deviceType: cfg.deviceType,
      deviceModel: cfg.deviceModel,
      key: cfg.cert.key,
      cert: cfg.cert.cert,
    })
    await next.start({ allowEphemeralFallback: true })
    receiver = next
    return receiver
  }

  // Default to receiving on load; disable with `autoReceive: false` in config.
  if (config?.autoReceive !== false) {
    try {
      await startReceiver()
    } catch (error) {
      console.warn('[localsend] auto-receive failed:', error?.code, error?.message)
    }
  }

  /* ------------------------------- routes ------------------------------- */

  registerRoute(ctx, '/localsend/receiver', 'GET', async (_req, res) => {
    if (!receiver || !receiver.running) {
      return sendJson(res, 200, { running: false })
    }
    sendJson(res, 200, {
      running: true,
      alias: receiver.alias,
      port: receiver.actualPort,
      fingerprint: receiver.fingerprint,
      destination: receiver.destination,
      received: receiver.received.map((r) => ({ from: r.from, fileName: r.fileName, path: r.path, size: r.size, at: r.at })),
    })
  })

  registerRoute(ctx, '/localsend/devices', 'GET', async (_req, res) => {
    const devices = await discoverDevices({ self: selfInfo(cfg), timeoutMs: 3000 })
    sendJson(res, 200, { devices })
  })

  registerRoute(ctx, '/localsend/receiver/start', 'POST', async (req, res) => {
    const body = await readJsonBody(req)
    try {
      const next = await startReceiver(body)
      sendJson(res, 200, {
        ok: true,
        status: {
          ...next.status(),
          received: next.received.map((r) => ({ from: r.from, fileName: r.fileName, path: r.path, size: r.size, at: r.at })),
        },
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, code: 'error', message: error?.message ?? String(error) })
    }
  })

  registerRoute(ctx, '/localsend/receiver/stop', 'POST', async (_req, res) => {
    if (receiver?.running) await receiver.stop()
    receiver = null
    sendJson(res, 200, { ok: true, running: false })
  })

  registerRoute(ctx, '/localsend/send', 'POST', async (req, res) => {
    const body = await readJsonBody(req)
    if (!Array.isArray(body.files) || body.files.length === 0) {
      return sendJson(res, 400, { ok: false, error: 'no files to send' })
    }
    let target = body.device
    if (typeof target === 'string' || target === null || target === undefined) {
      target = await resolveDevice(target ?? null, cfg)
    }
    if (!target || !target.ip) {
      return sendJson(res, 400, { ok: false, error: 'a device with an ip address is required' })
    }
    try {
      const result = await sendFiles({ device: target, files: body.files, pin: body.pin, self: selfInfo(cfg) })
      await cleanupStaged(body.files)
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
    }
  })

  registerRoute(ctx, '/localsend/pick-files', 'POST', async (_req, res) => {
    const paths = await pickFiles()
    sendJson(res, 200, { paths })
  })

  registerRoute(ctx, '/localsend/stage', 'POST', async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const name = url.searchParams.get('name') || `dropped-${Date.now()}`
    const ext = path.extname(name)
    const base = path.basename(name, ext) || 'dropped'
    await fsp.mkdir(stageDir, { recursive: true })
    const dest = path.join(stageDir, `${base}-${crypto.randomUUID().slice(0, 8)}${ext}`)
    await streamToFile(req, dest)
    staged.add(dest)
    sendJson(res, 200, { path: dest })
  })

  registerRoute(ctx, '/localsend/open', 'POST', async (req, res) => {
    const body = await readJsonBody(req)
    const target = body?.path
    if (typeof target !== 'string' || target.trim() === '') {
      return sendJson(res, 400, { ok: false, error: 'a path is required' })
    }
    // Only allow opening files inside the receive folder(s).
    const roots = [cfg.destination, receiver?.destination].filter((r) => typeof r === 'string' && r !== '')
    const resolved = path.resolve(target)
    const allowed = roots.some((root) => {
      const r = path.resolve(root)
      return resolved === r || resolved.startsWith(r + path.sep)
    })
    if (!allowed) {
      return sendJson(res, 403, { ok: false, error: 'path is outside the receive directory' })
    }
    openInFileManager(resolved, body?.mode === 'reveal' ? 'reveal' : 'open')
    sendJson(res, 200, { ok: true })
  })

  /* -------------------------------- tool -------------------------------- */

  ctx.tools.register({
    name: TOOL_NAME,
    description:
      "Send and receive files over the local network using the LocalSend protocol (v2). Use `discover` to list reachable LocalSend devices (phones, desktops, tablets), `send` to push one or more local files to a device, and `receive`/`status`/`stop` to run a receiver that lets other devices send files onto this machine. Prefer this for moving files to a phone or another computer on the same Wi-Fi without any cloud upload.",
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['discover', 'send', 'receive', 'status', 'stop'],
          description: 'What to do: discover devices, send files, run/check/stop the receiver.',
        },
        device: {
          type: 'string',
          description:
            "For `send`: which device to target. Accepts an alias, an 'ip:port' address, or a fingerprint prefix from a previous `discover` result. If omitted, the most recently discovered device is used.",
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'For `send`: absolute paths of the files to send.',
        },
        pin: {
          type: 'string',
          description: 'For `send`: the receiver PIN, if that device requires one.',
        },
        destination: {
          type: 'string',
          description: 'For `receive`: directory to save incoming files into. Defaults to the DSH home localsend-received folder.',
        },
        alias: {
          type: 'string',
          description: 'For `receive`: the name this machine advertises to other devices.',
        },
        port: {
          type: 'integer',
          description: 'For `receive`: TCP/UDP port. Default 53317; if it is taken the receiver falls back to an ephemeral port automatically.',
        },
        timeoutMs: {
          type: 'integer',
          description: 'For `discover`: how long to listen, in milliseconds. Default 3000.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },

    async execute(args) {
      switch (args?.action) {
        case 'discover': {
          const timeoutMs = Math.min(Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : 3000, 15000)
          const devices = await discoverDevices({ self: selfInfo(cfg), timeoutMs })
          if (devices.length === 0) {
            return 'No LocalSend devices found on the network. Make sure the other device has LocalSend open, is on the same Wi-Fi, and has not disabled device discovery.'
          }
          return `Found ${devices.length} device(s):\n${devices.map(formatDevice).join('\n')}`
        }
        case 'send': {
          if (!Array.isArray(args?.files) || args.files.length === 0) {
            throw new Error('send requires at least one file path in `files`')
          }
          const target = await resolveDevice(args?.device, cfg)
          const result = await sendFiles({ device: target, files: args.files, pin: args?.pin, self: selfInfo(cfg) })
          await cleanupStaged(args.files)
          const names = result.sent.map((f) => `"${f}"`).join(', ')
          return `Sent ${result.sent.length} file(s) to "${result.receiver ?? target.alias}" (session ${result.sessionId}).\n${result.note ? result.note + '\n' : ''}Files: ${names || '(none accepted)'}`
        }
        case 'receive': {
          if (receiver?.running) {
            return `Receiver is already running. ${formatStatus(receiver)}`
          }
          const destination = typeof args?.destination === 'string' && args.destination !== '' ? args.destination : cfg.destination
          const alias = typeof args?.alias === 'string' && args.alias !== '' ? args.alias : cfg.alias
          await startReceiver({ destination, alias, port: args?.port })
          return `Receiver started. Other devices can now send files to "${alias}" (announced as ${receiver.actualPort} on the LAN, fingerprint ${receiver.fingerprint.slice(0, 12)}…). Files land in:\n${destination}`
        }
        case 'status': {
          if (!receiver || !receiver.running) return 'Receiver is not running.'
          return formatStatus(receiver) + '\n\nReceived so far:\n' + formatReceived(receiver.received)
        }
        case 'stop': {
          if (!receiver || !receiver.running) return 'Receiver was not running.'
          const count = receiver.received.length
          await receiver.stop()
          receiver = null
          return `Receiver stopped. ${count} file(s) were received in total.`
        }
        default:
          throw new Error(`unknown action ${JSON.stringify(args?.action)}`)
      }
    },
  })

  // Stop the receiver when the plugin fiber is disposed (disable/reload).
  ctx.effect(
    () => () => {
      const r = receiver
      receiver = null
      if (r?.running) r.stop().catch(() => {})
    },
    'localsend: dispose receiver',
  )
}
