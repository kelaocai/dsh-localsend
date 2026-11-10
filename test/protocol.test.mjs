import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, promises as fsp } from 'node:fs'
import crypto from 'node:crypto'
import {
  discoverDevices,
  fingerprintFromCert,
  loadOrCreateCert,
  LocalSendReceiver,
  makeInfo,
  mimeFromName,
  sendFiles,
} from '../protocol.js'

const certDir = mkdtempSync(path.join(os.tmpdir(), 'localsend-cert-'))
const identity = loadOrCreateCert({ certDir })

test('loadOrCreateCert generates a stable, unique identity and reuses it', () => {
  assert.match(identity.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(identity.fingerprint, fingerprintFromCert(identity.cert))
  assert.match(identity.key, /BEGIN PRIVATE KEY/)
  assert.match(identity.cert, /BEGIN CERTIFICATE/)

  const again = loadOrCreateCert({ certDir })
  assert.equal(again.fingerprint, identity.fingerprint)

  const fresh = loadOrCreateCert({ certDir: mkdtempSync(path.join(os.tmpdir(), 'localsend-cert-fresh-')) })
  assert.notEqual(fresh.fingerprint, identity.fingerprint)
})

test('fingerprint is the sha256 of the certificate DER', () => {
  assert.equal(fingerprintFromCert(identity.cert), identity.fingerprint)
  assert.match(identity.fingerprint, /^[0-9a-f]{64}$/)
})

test('mimeFromName maps common extensions', () => {
  assert.equal(mimeFromName('a.png'), 'image/png')
  assert.equal(mimeFromName('a.mp4'), 'video/mp4')
  assert.equal(mimeFromName('a.pdf'), 'application/pdf')
  assert.equal(mimeFromName('a.unknownxyz'), 'application/octet-stream')
})

test('sendFiles uploads files into a LocalSendReceiver end-to-end', async () => {
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'localsend-recv-'))
  const { key, cert, fingerprint } = identity
  const receiver = new LocalSendReceiver({ alias: 'Test Receiver', port: 0, destination: dest, key, cert })
  await receiver.start()
  try {
    const src = await fsp.mkdtemp(path.join(os.tmpdir(), 'localsend-src-'))
    const textPath = path.join(src, 'hello.txt')
    const binaryPath = path.join(src, 'photo.png')
    await fsp.writeFile(textPath, 'hello localsend')
    const binary = crypto.randomBytes(128 * 1024)
    await fsp.writeFile(binaryPath, binary)

    const self = makeInfo({ alias: 'Test Sender', port: 53317, fingerprint })
    const result = await sendFiles({
      device: { ip: '127.0.0.1', port: receiver.actualPort, protocol: 'https', alias: 'Test Receiver' },
      files: [textPath, binaryPath],
      self,
    })

    assert.equal(result.ok, true)
    assert.equal(result.sent.length, 2)
    assert.equal(receiver.received.length, 2)

    const savedText = receiver.received.find((r) => r.fileName === 'hello.txt')
    const savedBinary = receiver.received.find((r) => r.fileName === 'photo.png')
    assert.ok(savedText, 'text file saved')
    assert.ok(savedBinary, 'binary file saved')
    assert.equal(await fsp.readFile(savedText.path, 'utf8'), 'hello localsend')
    assert.deepEqual(await fsp.readFile(savedBinary.path), binary)
  } finally {
    await receiver.stop()
  }
})

test('receiver reports running status and stops cleanly', async () => {
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'localsend-status-'))
  const { key, cert } = identity
  const receiver = new LocalSendReceiver({ alias: 'Status', port: 0, destination: dest, key, cert })
  await receiver.start()
  assert.equal(receiver.status().running, true)
  assert.equal(receiver.status().alias, 'Status')
  await receiver.stop()
  assert.equal(receiver.status().running, false)
})

test('discoverDevices resolves to an array without throwing', async () => {
  const devices = await discoverDevices({
    self: makeInfo({ alias: 'smoke', port: 53317, fingerprint: 'smoke-fingerprint' }),
    timeoutMs: 1500,
  })
  assert.ok(Array.isArray(devices))
})

test('receiver falls back to an ephemeral port when the configured port is in use', async () => {
  const destA = await fsp.mkdtemp(path.join(os.tmpdir(), 'localsend-fb-a-'))
  const destB = await fsp.mkdtemp(path.join(os.tmpdir(), 'localsend-fb-b-'))
  const { key, cert } = identity

  const a = new LocalSendReceiver({ alias: 'A', port: 0, destination: destA, key, cert })
  await a.start()
  try {
    const portA = a.actualPort
    const b = new LocalSendReceiver({ alias: 'B', port: portA, destination: destB, key, cert })
    await b.start({ allowEphemeralFallback: true })
    try {
      assert.equal(b.status().running, true)
      assert.notEqual(b.actualPort, portA)
    } finally {
      await b.stop()
    }
  } finally {
    await a.stop()
  }
})
