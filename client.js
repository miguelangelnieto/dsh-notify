/**
 * Client half of dsh-notify: posts the notifications the Host publishes.
 *
 * These banners come from the page inside the DeepSeek Harness window, so the
 * operating system attributes them to the app — its name, its icon, and a
 * click that brings the window forward — instead of to the system script
 * runner the Host-side fallback has to use.
 *
 * The page keeps its own `EventSource` subscription alive: a browser retries a
 * dropped stream by itself, but a closed one (an HTTP failure, or the Host
 * plugin unloading and re-registering its route) is recreated here with
 * backoff, so toggling the plugin never leaves the window silent.
 *
 * @module dsh-notify/client
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-notify',
  factory() {
    /** Longest wait before another subscription attempt. */
    const MAX_BACKOFF_MS = 30_000

    /**
     * Show one banner if the user has not opted out for the focused window.
     * @param {{ title?: unknown, body?: unknown, silent?: unknown }} payload - Host notification.
     * @param {boolean} suppressWhenFocused - Skip while the window has focus.
     * @returns {void}
     */
    function show(payload, suppressWhenFocused) {
      if (suppressWhenFocused && document.hasFocus()) return
      const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : 'DeepSeek Harness'
      const body = typeof payload.body === 'string' ? payload.body : ''
      const notify = () => {
        try {
          const notification = new Notification(title, { body, silent: payload.silent === true })
          notification.onclick = () => {
            window.focus()
            notification.close()
          }
        } catch (error) {
          console.warn('dsh-notify: cannot show a notification', error)
        }
      }
      if (Notification.permission === 'granted') {
        notify()
        return
      }
      if (Notification.permission === 'denied') return
      Notification.requestPermission()
        .then((permission) => {
          if (permission === 'granted') notify()
        })
        .catch(() => {})
    }

    return {
      apply(ctx) {
        if (typeof Notification === 'undefined' || typeof EventSource === 'undefined') return
        let suppressWhenFocused = false
        let attempt = 0
        /** @type {EventSource | null} */
        let source = null
        /** @type {ReturnType<typeof setTimeout> | null} */
        let retry = null

        const onMessage = (event) => {
          let payload
          try {
            payload = JSON.parse(event.data)
          } catch {
            return
          }
          if (payload === null || typeof payload !== 'object') return
          if (payload.kind === 'hello') {
            suppressWhenFocused = payload.suppressWhenFocused === true
            return
          }
          if (payload.kind === 'notify') show(payload, suppressWhenFocused)
        }

        const connect = () => {
          const current = new EventSource('/dsh-notify/events')
          source = current
          current.addEventListener('message', onMessage)
          current.addEventListener('open', () => {
            attempt = 0
          })
          current.addEventListener('error', () => {
            // A live retry keeps readyState CONNECTING: the browser reconnects on its own.
            if (current.readyState !== EventSource.CLOSED) return
            current.close()
            if (retry !== null) return
            const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempt, 5))
            attempt += 1
            retry = setTimeout(() => {
              retry = null
              connect()
            }, delay)
          })
        }

        connect()
        ctx.effect(() => () => {
          if (retry !== null) clearTimeout(retry)
          source?.close()
        })
      },
    }
  },
})
