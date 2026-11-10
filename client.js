/**
 * Browser half of LocalSend.
 *
 * Registers a global sidebar entry whose id equals the `main` panel key, so the
 * sidebar row selects this panel by itself. It talks to the Host half over the
 * same-origin `/localsend/*` routes, keeps only a rendered copy of the state,
 * and never imports a Harness Client package: controls render from theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-localsend',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'localsend'
    const RECEIVER_POLL_MS = 2500
    const DEVICES_POLL_MS = 7000

    const ZH = {
      'panel.title': 'LocalSend',
      'panel.hint': '局域网内收发文件：发现设备、发送文件、一键开启接收。',
      'receiver.title': '接收',
      'receiver.running': '接收中',
      'receiver.stopped': '未开启',
      'receiver.start': '开始接收',
      'receiver.stop': '停止',
      'receiver.alias': '名称',
      'receiver.port': '端口',
      'receiver.destination': '保存到',
      'receiver.received': '已收到',
      'receiver.openFolder': '打开目录',
      'file.reveal': '在 Finder 中显示',
      'file.copyPath': '复制路径',
      'receiver.empty': '还没有收到文件。开启接收后，手机 / 其他电脑上的 LocalSend 就能把文件发进这台机器。',
      'devices.title': '设备',
      'devices.refresh': '刷新',
      'devices.scanning': '正在扫描局域网…',
      'devices.empty': '没有发现设备。请确认对方已打开 LocalSend、和本机在同一 Wi-Fi，且未关闭设备发现。',
      'devices.select': '选择此设备',
      'send.title': '发送',
      'send.noDevice': '先在上方选择一台设备',
      'send.chooseFiles': '选择文件',
      'send.dropHint': '拖文件到这里，或',
      'send.pathPlaceholder': '输入本机文件路径后回车',
      'send.add': '添加',
      'send.send': '发送',
      'send.sending': '发送中…',
      'send.sent': '已发送',
      'send.failed': '发送失败',
      'send.none': '还没有选择要发送的文件',
      'send.pinLabel': 'PIN（可选）',
      'send.pinPlaceholder': '对方 PIN',
      'send.pinHint': '只有当对方设备开启了 PIN 校验时才需要填写；通常留空即可。',
      'file.remove': '移除',
      'toast.cancelled': '未选择文件',
      'toast.noPicker': '当前平台没有原生文件选择器，请用拖拽或直接输入路径',
      'toast.copied': '已复制路径',
      'toast.copyFailed': '复制失败，请手动复制',
    }

    const EN = {
      'panel.title': 'LocalSend',
      'panel.hint': 'Send and receive files over the local network.',
      'receiver.title': 'Receive',
      'receiver.running': 'Receiving',
      'receiver.stopped': 'Off',
      'receiver.start': 'Start receiving',
      'receiver.stop': 'Stop',
      'receiver.alias': 'Alias',
      'receiver.port': 'Port',
      'receiver.destination': 'Saves to',
      'receiver.received': 'Received',
      'receiver.openFolder': 'Open folder',
      'file.reveal': 'Show in Finder',
      'file.copyPath': 'Copy path',
      'receiver.empty': 'Nothing received yet. Start the receiver and other LocalSend devices can send files to this machine.',
      'devices.title': 'Devices',
      'devices.refresh': 'Refresh',
      'devices.scanning': 'Scanning the local network…',
      'devices.empty': 'No devices found. Make sure the other device has LocalSend open, is on the same Wi-Fi, and has discovery enabled.',
      'devices.select': 'Select this device',
      'send.title': 'Send',
      'send.noDevice': 'Select a device above first',
      'send.chooseFiles': 'Choose files',
      'send.dropHint': 'Drop files here, or',
      'send.pathPlaceholder': 'Type a host file path and press Enter',
      'send.add': 'Add',
      'send.send': 'Send',
      'send.sending': 'Sending…',
      'send.sent': 'Sent',
      'send.failed': 'Send failed',
      'send.none': 'No files chosen to send',
      'send.pinLabel': 'PIN (optional)',
      'send.pinPlaceholder': 'receiver PIN',
      'send.pinHint': 'Only needed when the receiving device requires a PIN; usually leave it empty.',
      'file.remove': 'Remove',
      'toast.cancelled': 'No files selected',
      'toast.noPicker': 'No native file picker on this platform; drop files or type a path instead.',
      'toast.copied': 'Path copied',
      'toast.copyFailed': 'Copy failed; copy manually',
    }

    const STYLE = `
.ls-root{height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.ls-head{flex:none;display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.ls-heading{min-width:0;display:flex;flex-direction:column;gap:1px}
.ls-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em;display:flex;align-items:center;gap:7px}
.ls-title svg{color:var(--dsw-alias-brand-primary)}
.ls-hint{margin:0;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 20px 18px;display:flex;flex-direction:column;gap:16px}
.ls-card{border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ls-card-head{display:flex;align-items:center;gap:10px;padding:11px 14px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
.ls-card-title{margin:0;font-size:13px;font-weight:600;display:flex;align-items:center;gap:7px}
.ls-card-title svg{color:var(--dsw-alias-brand-primary)}
.ls-badge{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}
.ls-badge-on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary)}
.ls-badge-off{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 12%,transparent);color:var(--dsw-alias-label-secondary)}
.ls-dot{width:6px;height:6px;border-radius:999px;background:currentColor}
.ls-spin{animation:ls-spin 1s linear infinite}
@keyframes ls-spin{to{transform:rotate(360deg)}}
.ls-card-side{margin-left:auto;display:flex;align-items:center;gap:8px;flex:none}
.ls-btn{height:30px;padding:0 11px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;flex:none}
.ls-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.ls-btn:disabled{opacity:.45;cursor:default}
.ls-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.ls-btn-primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,#000);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 88%,#000)}
.ls-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.ls-btn-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.ls-meta{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;padding:11px 14px;font-size:12px}
.ls-meta dt{margin:0;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-meta dd{margin:0;min-width:0;word-break:break-all;font-variant-numeric:tabular-nums}
.ls-received{padding:0 14px 12px;display:flex;flex-direction:column;gap:4px}
.ls-received-item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px;font-size:12px}
.ls-received-item:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.ls-received-main{min-width:0;flex:1 1 auto;display:flex;align-items:center;gap:8px;cursor:pointer}
.ls-received-text{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:1px}
.ls-received-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-received-path{min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;word-break:break-all;font-variant-numeric:tabular-nums}
.ls-received-size{margin-left:auto;flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ls-list{list-style:none;margin:0;padding:6px;display:flex;flex-direction:column;gap:2px}
.ls-device{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;cursor:pointer;border:1px solid transparent}
.ls-device:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 4%,transparent)}
.ls-device[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}
.ls-device-icon{flex:none;width:32px;height:32px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-brand-primary)}
.ls-device-main{min-width:0;display:flex;flex-direction:column;gap:1px}
.ls-device-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-device-sub{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.ls-device-check{margin-left:auto;flex:none;color:var(--dsw-alias-brand-primary);display:inline-flex}
.ls-empty{margin:10px 8px;display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:22px 18px;border-radius:12px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px}
.ls-empty-icon{width:40px;height:40px;border-radius:11px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-brand-primary)}
.ls-dropzone{border:1.5px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}
.ls-dropzone.is-over{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,transparent)}
.ls-dropzone p{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);text-align:center}
.ls-file-row{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px}
.ls-file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-file-path{min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ls-ibtn{width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.ls-ibtn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.ls-input{height:34px;box-sizing:border-box;padding:0 12px;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;outline:none;flex:1 1 auto;min-width:0}
.ls-input::placeholder{color:var(--dsw-alias-label-secondary)}
.ls-input:focus{border-color:var(--dsw-alias-brand-primary)}
.ls-row{display:flex;align-items:center;gap:8px}
.ls-grow{flex:1 1 auto;min-width:0}
.ls-send-foot{display:flex;align-items:center;gap:8px;padding-top:2px}
.ls-pin-field{display:flex;align-items:center;gap:7px;flex:none}
.ls-pin-label{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ls-pin{width:110px;flex:none}
.ls-pin-hint{margin:0;padding:0 14px 14px;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.ls-toast{flex:none;display:flex;align-items:center;gap:8px;margin:0 20px 12px;padding:8px 10px;border-radius:8px;font-size:12px;border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.ls-toast.is-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary)}
.ls-toast.is-ok{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);color:var(--dsw-alias-brand-primary)}
.ls-btn:focus-visible,.ls-ibtn:focus-visible,.ls-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
`

    /* ------------------------------ helpers ------------------------------ */

    function useLocaleRevision(store) {
      return React.useSyncExternalStore(store.subscribe, store.revision, store.revision)
    }

    async function getJSON(url, signal) {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error((data && (data.message || data.error)) || 'status ' + response.status)
      return data
    }

    async function postJSON(url, body, signal) {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal,
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error((data && (data.message || data.error)) || 'status ' + response.status)
      return data
    }

    function humanSize(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return ''
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
      return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {}
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.top = '-1000px'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        return ok
      } catch {
        return false
      }
    }

    /* ------------------------------- icons ------------------------------- */

    function icon(size, children, extra) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
          ...(extra || {}),
        },
        children,
      )
    }

    const IconLocalSend = ({ size = 15 }) =>
      h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' } },
        h('path', { d: 'M12 3 L20 12 L12 21 L4 12 Z' }),
        h('path', { d: 'M12 7 L16 12 L12 17 L8 12 Z', fill: 'currentColor', stroke: 'none' }),
      )

    const IconRefresh = ({ size = 14, spin = false }) =>
      h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false', style: { display: 'block' }, className: spin ? 'ls-spin' : undefined },
        h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
        h('path', { d: 'M20 4v4h-4' }),
      )

    const IconPower = ({ size = 14 }) => icon(size, [
      h('path', { key: 'a', d: 'M12 3v8' }),
      h('path', { key: 'b', d: 'M7.1 5.6a8 8 0 1 0 9.8 0' }),
    ])

    const IconSend = ({ size = 14 }) => icon(size, [
      h('path', { key: 'a', d: 'M3 11.5 21 4l-5 16-4.3-6L3 11.5z' }),
      h('path', { key: 'b', d: 'M11.7 14 21 4' }),
    ])

    const IconFile = ({ size = 14 }) => icon(size, [
      h('path', { key: 'a', d: 'M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z' }),
      h('path', { key: 'b', d: 'M13.5 3v5.5H19' }),
    ])

    const IconPlus = ({ size = 14 }) => icon(size, [h('path', { key: 'a', d: 'M12 5v14' }), h('path', { key: 'b', d: 'M5 12h14' })])

    const IconX = ({ size = 14 }) => icon(size, [h('path', { key: 'a', d: 'M6 6l12 12' }), h('path', { key: 'b', d: 'M18 6L6 18' })])

    const IconCheck = ({ size = 14 }) => icon(size, h('path', { d: 'M5 12.5l4.4 4.4L19 7' }), { strokeWidth: 2.2 })

    const IconInbox = ({ size = 20 }) => icon(size, [
      h('path', { key: 'a', d: 'M3.5 12.5h4l1.6 2.4h5.8l1.6-2.4h4' }),
      h('path', { key: 'b', d: 'M3.5 12.5l2.3-6.4c.3-.85 1.1-1.4 2-1.4h8.4c.9 0 1.7.55 2 1.4l2.3 6.4v3.6c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7z' }),
    ])

    const IconFolder = ({ size = 14 }) => icon(size, h('path', { d: 'M3 6.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }))

    const IconCopy = ({ size = 14 }) => icon(size, [
      h('rect', { key: 'a', x: 9, y: 9, width: 11, height: 11, rx: 2 }),
      h('path', { key: 'b', d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }),
    ])

    function deviceIcon(type) {
      if (type === 'mobile') {
        return icon(15, [
          h('rect', { key: 'a', x: 7, y: 2.5, width: 10, height: 19, rx: 2.2 }),
          h('path', { key: 'b', d: 'M11 18.2h2' }),
        ])
      }
      if (type === 'tablet') {
        return icon(15, [
          h('rect', { key: 'a', x: 4.5, y: 3, width: 15, height: 18, rx: 2.2 }),
          h('path', { key: 'b', d: 'M10.6 18h2.8' }),
        ])
      }
      if (type === 'web') {
        return icon(15, [h('circle', { key: 'a', cx: 12, cy: 12, r: 8.5 }), h('path', { key: 'b', d: 'M3.5 12h17M12 3.5c2.5 2.4 3.8 5.2 3.8 8.5s-1.3 6.1-3.8 8.5c-2.5-2.4-3.8-5.2-3.8-8.5S9.5 5.9 12 3.5z' })])
      }
      return icon(15, [h('rect', { key: 'a', x: 3, y: 4, width: 18, height: 13, rx: 1.8 }), h('path', { key: 'b', d: 'M8.5 20.5h7M12 17v3.5' })])
    }

    /* ------------------------------- panel ------------------------------- */

    function Panel({ t, localeStore }) {
      useLocaleRevision(localeStore)

      const [receiver, setReceiver] = useState(null) // {running,...} | null (loading)
      const [devices, setDevices] = useState([])
      const [scanning, setScanning] = useState(true)
      const [selectedId, setSelectedId] = useState(null) // device ip:port key
      const [files, setFiles] = useState([]) // [{path, name}]
      const [draft, setDraft] = useState('')
      const [pin, setPin] = useState('')
      const [busy, setBusy] = useState(false)
      const [over, setOver] = useState(false)
      const [toast, setToast] = useState(null)

      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])

      const selectedDevice = useMemo(
        () => devices.find((d) => `${d.ip}:${d.port}` === selectedId) ?? null,
        [devices, selectedId],
      )

      const showToast = useCallback((kind, message) => {
        setToast({ kind, message })
        window.setTimeout(() => setToast((current) => (current && current.message === message ? null : current)), 5000)
      }, [])

      const refreshReceiver = useCallback(async () => {
        try {
          const data = await getJSON('/localsend/receiver')
          if (!alive.current) return
          setReceiver(data)
        } catch {
          if (!alive.current) return
          setReceiver(null)
        }
      }, [])

      const refreshDevices = useCallback(async (quiet) => {
        if (!quiet) setScanning(true)
        try {
          const data = await getJSON('/localsend/devices')
          if (!alive.current) return
          setDevices(Array.isArray(data.devices) ? data.devices : [])
          setScanning(false)
        } catch {
          if (!alive.current) return
          setScanning(false)
        }
      }, [])

      useEffect(() => {
        refreshReceiver()
        refreshDevices(false)
        const r = window.setInterval(refreshReceiver, RECEIVER_POLL_MS)
        const d = window.setInterval(() => {
          if (document.visibilityState === 'visible') refreshDevices(true)
        }, DEVICES_POLL_MS)
        const onVisible = () => {
          if (document.visibilityState === 'visible') {
            refreshReceiver()
            refreshDevices(true)
          }
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          window.clearInterval(r)
          window.clearInterval(d)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [refreshReceiver, refreshDevices])

      const toggleReceiver = useCallback(async () => {
        try {
          if (receiver?.running) {
            await postJSON('/localsend/receiver/stop')
            setReceiver({ running: false })
          } else {
            const data = await postJSON('/localsend/receiver/start', {})
            setReceiver({ running: true, ...data.status })
          }
        } catch (error) {
          showToast('error', error.message)
        }
      }, [receiver, showToast])

      const openPath = useCallback(async (pathValue, mode) => {
        try {
          await postJSON('/localsend/open', { path: pathValue, mode })
        } catch (error) {
          showToast('error', error.message)
        }
      }, [showToast])

      const copyPath = useCallback(async (pathValue) => {
        const ok = await copyText(pathValue)
        showToast(ok ? 'ok' : 'error', ok ? t('toast.copied') : t('toast.copyFailed'))
      }, [showToast, t])

      const addFiles = useCallback((paths) => {
        setFiles((current) => {
          const seen = new Set(current.map((f) => f.path))
          const additions = paths
            .filter((p) => typeof p === 'string' && p.trim() !== '' && !seen.has(p))
            .map((p) => ({ path: p, name: p.split('/').pop() || p }))
          return [...current, ...additions]
        })
      }, [])

      const chooseFiles = useCallback(async () => {
        try {
          const data = await postJSON('/localsend/pick-files', {})
          const paths = Array.isArray(data.paths) ? data.paths : []
          if (paths.length === 0) {
            showToast('neutral', t('toast.cancelled'))
            return
          }
          addFiles(paths)
        } catch (error) {
          showToast('error', error.message)
        }
      }, [addFiles, showToast, t])

      const onAddPath = useCallback(
        (event) => {
          event.preventDefault()
          const pathValue = draft.trim()
          if (pathValue === '') return
          addFiles([pathValue])
          setDraft('')
        },
        [draft, addFiles],
      )

      const removeFile = useCallback((pathToRemove) => {
        setFiles((current) => current.filter((f) => f.path !== pathToRemove))
      }, [])

      const onDrop = useCallback(
        async (event) => {
          event.preventDefault()
          setOver(false)
          const dropped = Array.from(event.dataTransfer?.files ?? [])
          if (dropped.length === 0) return
          for (const file of dropped) {
            try {
              const response = await fetch(`/localsend/stage?name=${encodeURIComponent(file.name)}`, {
                method: 'POST',
                credentials: 'same-origin',
                body: file,
              })
              const data = await response.json().catch(() => null)
              if (!response.ok || !data?.path) throw new Error('stage failed')
              addFiles([data.path])
            } catch (error) {
              showToast('error', error.message)
            }
          }
        },
        [addFiles, showToast],
      )

      const send = useCallback(async () => {
        if (!selectedDevice || files.length === 0) return
        setBusy(true)
        try {
          const data = await postJSON('/localsend/send', {
            device: selectedDevice,
            files: files.map((f) => f.path),
            pin: pin.trim() === '' ? undefined : pin.trim(),
          })
          setFiles([])
          setPin('')
          const names = Array.isArray(data.sent) ? data.sent : []
          showToast('ok', `${t('send.sent')}: ${names.join(', ') || t('send.none')}`)
        } catch (error) {
          showToast('error', `${t('send.failed')}: ${error.message}`)
        } finally {
          setBusy(false)
        }
      }, [selectedDevice, files, pin, showToast, t])

      /* ------------------------------ render ------------------------------ */

      const receiverRows = receiver?.running
        ? [
            [t('receiver.alias'), receiver.alias],
            [t('receiver.port'), String(receiver.port)],
            [t('receiver.destination'), receiver.destination],
            [t('receiver.received'), String((receiver.received ?? []).length)],
          ]
        : null

      const receivedList = receiver?.running ? receiver.received ?? [] : []

      return h(
        'div',
        { className: 'ls-root' },
        h('style', null, STYLE),
        h(
          'header',
          { className: 'ls-head' },
          h(
            'div',
            { className: 'ls-heading' },
            h('h1', { className: 'ls-title' }, h(IconLocalSend, { size: 15 }), t('panel.title')),
            h('p', { className: 'ls-hint' }, t('panel.hint')),
          ),
        ),
        toast
          ? h(
              'div',
              { className: 'ls-toast' + (toast.kind === 'error' ? ' is-error' : toast.kind === 'ok' ? ' is-ok' : '') },
              toast.message,
            )
          : null,
        h(
          'div',
          { className: 'ls-scroll' },
          /* receiver card */
          h(
            'section',
            { className: 'ls-card' },
            h(
              'div',
              { className: 'ls-card-head' },
              h('h2', { className: 'ls-card-title' }, h(IconInbox, { size: 15 }), t('receiver.title')),
              h(
                'span',
                { className: 'ls-badge ' + (receiver?.running ? 'ls-badge-on' : 'ls-badge-off') },
                h('span', { className: 'ls-dot' }),
                receiver?.running ? t('receiver.running') : t('receiver.stopped'),
              ),
              h(
                'div',
                { className: 'ls-card-side' },
                receiver?.running
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'ls-btn',
                        title: t('receiver.openFolder'),
                        onClick: () => openPath(receiver.destination, 'folder'),
                      },
                      h(IconFolder, { size: 14 }),
                      t('receiver.openFolder'),
                    )
                  : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ls-btn ' + (receiver?.running ? '' : 'ls-btn-primary'),
                    onClick: toggleReceiver,
                    disabled: receiver === null,
                  },
                  h(IconPower, { size: 14 }),
                  receiver?.running ? t('receiver.stop') : t('receiver.start'),
                ),
              ),
            ),
            receiverRows
              ? h(
                  'dl',
                  { className: 'ls-meta' },
                  receiverRows.map(([label, value]) => [
                    h('dt', { key: 'k-' + label }, label),
                    h('dd', { key: 'v-' + label }, value),
                  ]),
                )
              : null,
            receiver?.running && receivedList.length > 0
              ? h(
                  'div',
                  { className: 'ls-received' },
                  receivedList.map((f) =>
                    h(
                      'div',
                      {
                        key: f.path + f.at,
                        className: 'ls-received-item',
                        title: `${t('file.reveal')}: ${f.path}`,
                      },
                      h(
                        'div',
                        {
                          className: 'ls-received-main',
                          role: 'button',
                          tabIndex: 0,
                          onClick: () => openPath(f.path, 'reveal'),
                          onKeyDown: (event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              openPath(f.path, 'reveal')
                            }
                          },
                        },
                        h(IconFile, { size: 14 }),
                        h(
                          'span',
                          { className: 'ls-received-text' },
                          h('span', { className: 'ls-received-name' }, f.fileName),
                          h('span', { className: 'ls-received-path' }, f.path),
                        ),
                      ),
                      h('span', { className: 'ls-received-size' }, humanSize(f.size)),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'ls-ibtn',
                          title: t('file.copyPath'),
                          'aria-label': t('file.copyPath'),
                          onClick: (event) => {
                            event.stopPropagation()
                            copyPath(f.path)
                          },
                        },
                        h(IconCopy, { size: 14 }),
                      ),
                    ),
                  ),
                )
              : receiver?.running
                ? h('div', { className: 'ls-empty' }, t('receiver.empty'))
                : null,
          ),
          /* devices card */
          h(
            'section',
            { className: 'ls-card' },
            h(
              'div',
              { className: 'ls-card-head' },
              h('h2', { className: 'ls-card-title' }, h(IconLocalSend, { size: 14 }), t('devices.title')),
              h(
                'div',
                { className: 'ls-card-side' },
                scanning ? h(IconRefresh, { size: 14, spin: true }) : null,
                h('button', { type: 'button', className: 'ls-btn ls-btn-ghost', onClick: () => refreshDevices(false) }, h(IconRefresh, { size: 14 }), t('devices.refresh')),
              ),
            ),
            scanning && devices.length === 0
              ? h('div', { className: 'ls-empty' }, h('span', null, t('devices.scanning')))
              : devices.length === 0
                ? h('div', { className: 'ls-empty' }, h('div', { className: 'ls-empty-icon' }, h(IconInbox, { size: 20 })), t('devices.empty'))
                : h(
                    'ul',
                    { className: 'ls-list' },
                    devices.map((d) => {
                      const key = `${d.ip}:${d.port}`
                      const pressed = selectedId === key
                      return h(
                        'li',
                        { key },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'ls-device',
                            'aria-pressed': pressed,
                            onClick: () => setSelectedId(pressed ? null : key),
                          },
                          h('span', { className: 'ls-device-icon' }, deviceIcon(d.deviceType)),
                          h(
                            'span',
                            { className: 'ls-device-main' },
                            h('span', { className: 'ls-device-name' }, d.alias),
                            h('span', { className: 'ls-device-sub' }, `${d.ip}:${d.port} · ${d.protocol} · ${(d.fingerprint || '').slice(0, 12)}…`),
                          ),
                          pressed ? h('span', { className: 'ls-device-check' }, h(IconCheck, { size: 15 })) : null,
                        ),
                      )
                    }),
                  ),
          ),
          /* send card */
          h(
            'section',
            { className: 'ls-card' },
            h(
              'div',
              { className: 'ls-card-head' },
              h('h2', { className: 'ls-card-title' }, h(IconSend, { size: 14 }), t('send.title')),
              h('span', { className: 'ls-badge ls-badge-off' }, selectedDevice ? selectedDevice.alias : t('send.noDevice')),
            ),
            h(
              'div',
              {
                className: 'ls-dropzone' + (over ? ' is-over' : ''),
                onDragOver: (event) => { event.preventDefault(); setOver(true) },
                onDragLeave: () => setOver(false),
                onDrop,
              },
              files.length > 0
                ? files.map((f) =>
                    h(
                      'div',
                      { key: f.path, className: 'ls-file-row', title: f.path },
                      h(IconFile, { size: 14 }),
                      h('span', { className: 'ls-file-name' }, f.name),
                      h('span', { className: 'ls-file-path' }, f.path),
                      h('button', { type: 'button', className: 'ls-ibtn', 'aria-label': t('file.remove'), title: t('file.remove'), onClick: () => removeFile(f.path) }, h(IconX, { size: 14 })),
                    ),
                  )
                : null,
              h('p', null, t('send.dropHint'), ' ', h('button', { type: 'button', className: 'ls-btn ls-btn-ghost', onClick: chooseFiles }, t('send.chooseFiles'))),
            ),
            h(
              'form',
              { className: 'ls-row', style: { padding: '12px 14px 14px' }, onSubmit: onAddPath },
              h('input', {
                className: 'ls-input',
                type: 'text',
                value: draft,
                placeholder: t('send.pathPlaceholder'),
                'aria-label': t('send.pathPlaceholder'),
                onChange: (event) => setDraft(event.target.value),
              }),
              h('button', { type: 'submit', className: 'ls-btn', disabled: draft.trim() === '' }, h(IconPlus, { size: 14 }), t('send.add')),
            ),
            h(
              'div',
              { className: 'ls-send-foot', style: { padding: '0 14px 6px' } },
              h(
                'label',
                { className: 'ls-pin-field' },
                h('span', { className: 'ls-pin-label' }, t('send.pinLabel')),
                h('input', {
                  className: 'ls-input ls-pin',
                  type: 'text',
                  value: pin,
                  placeholder: t('send.pinPlaceholder'),
                  'aria-label': t('send.pinLabel'),
                  onChange: (event) => setPin(event.target.value),
                }),
              ),
              h('div', { className: 'ls-grow' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ls-btn ls-btn-primary',
                  disabled: !selectedDevice || files.length === 0 || busy,
                  onClick: send,
                },
                h(IconSend, { size: 14 }),
                busy ? t('send.sending') : t('send.send'),
              ),
            ),
            h('p', { className: 'ls-pin-hint' }, t('send.pinHint')),
          ),
        ),
      )
    }

    /* ------------------------------- apply ------------------------------- */

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      const localeStore = {
        subscribe: (listener) => ctx.locale.subscribe(listener),
        revision: () => ctx.locale.getSnapshot().revision,
      }

      ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'localsend: zh dictionary')
      ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'localsend: en dictionary')

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'localsend', order: 22, label: () => t('panel.title') },
          IconLocalSend,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          { name: 'main', key: 'localsend', locale: NS },
          (props) => h(Panel, { ...props, t, localeStore }),
        ),
      )
    }

    return { inject, apply }
  },
})
