import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, promises as fsp } from 'node:fs'
import * as plugin from '../index.js'

const certDir = mkdtempSync(path.join(os.tmpdir(), 'localsend-plugin-cert-'))

/** Minimal stand-in for the DSH services this plugin injects. */
function mockCtx() {
  const registered = []
  const routes = []
  return {
    registered,
    routes,
    tools: {
      register(def) {
        registered.push(def)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    connection: {
      requestRejection() {
        return undefined
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
  }
}

test('plugin exports the expected cordis surface', () => {
  assert.equal(plugin.name, 'localsend')
  assert.deepEqual(plugin.inject, ['webServer', 'connection', 'tools'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply registers the localsend tool and panel routes', async () => {
  const ctx = mockCtx()
  await plugin.apply(ctx, { autoReceive: false, certDir })
  assert.equal(ctx.registered.length, 1)
  const def = ctx.registered[0]
  assert.equal(def.name, 'localsend')
  assert.deepEqual(def.parameters.required, ['action'])
  assert.ok(def.parameters.properties.action.enum.includes('send'))
  assert.ok(def.parameters.properties.action.enum.includes('receive'))

  const paths = ctx.routes.map((r) => r.path)
  assert.ok(paths.includes('/localsend/receiver'))
  assert.ok(paths.includes('/localsend/devices'))
  assert.ok(paths.includes('/localsend/send'))
  assert.ok(paths.includes('/localsend/pick-files'))
})

test('the status action reports the receiver is off when auto-receive is disabled', async () => {
  const ctx = mockCtx()
  await plugin.apply(ctx, { autoReceive: false, certDir })
  const def = ctx.registered[0]
  const out = await def.execute({ action: 'status' })
  assert.equal(out, 'Receiver is not running.')
})

test('the discover action returns a string', async () => {
  const ctx = mockCtx()
  await plugin.apply(ctx, { autoReceive: false, certDir })
  const def = ctx.registered[0]
  const out = await def.execute({ action: 'discover', timeoutMs: 500 })
  assert.equal(typeof out, 'string')
  assert.ok(out.length > 0)
})

test('auto-receive starts the receiver on apply and stop tears it down', async () => {
  const ctx = mockCtx()
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), 'localsend-auto-'))
  await plugin.apply(ctx, { destination: dest, certDir })
  const def = ctx.registered[0]

  const status = await def.execute({ action: 'status' })
  assert.match(status, /Receiver: running/)

  const stopped = await def.execute({ action: 'stop' })
  assert.match(stopped, /Receiver stopped/)
})
