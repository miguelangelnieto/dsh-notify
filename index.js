/**
 * Desktop notifications for DeepSeek Harness.
 *
 * A reply you cannot see is worth a banner. This bundle watches the Session log
 * — a turn that completed, an `ask_user_question` call, an approval prompt — and
 * hands each one to the place that can show it:
 *
 * - With the Web page open, the banner is posted by the page itself
 *   (`new Notification`), so macOS shows DeepSeek Harness with its own icon and
 *   clicking the banner brings the app forward. The Host publishes each
 *   notification over the loopback route `/dsh-notify/events` that the Client
 *   half subscribes to with `EventSource`.
 * - With no page attached, the Host falls back to the platform notifier
 *   (`osascript` on macOS, `notify-send` on Linux) unless `fallback` is off.
 *
 * The triggers come from committed Session events rather than the interactive
 * waterfalls: a UI answerer claims a question or approval request before any
 * listener registered later in the process runs, while every Session event
 * reaches an observer. Nothing is written to the Session and no model request
 * is added.
 *
 * @module dsh-notify
 */

import { spawn } from 'node:child_process'

export const name = 'dsh-notify'
export const inject = ['webServer']

/** Loopback route the Client half subscribes to. */
const ROUTE_EVENTS = '/dsh-notify/events'

/** Loopback route reporting delivery state, for diagnostics. */
const ROUTE_STATUS = '/dsh-notify/status'

/** Longest reply excerpt carried in one notification body. */
const EXCERPT_LIMIT = 180

/** Longest notification line handed to a notifier. */
const LINE_LIMIT = 400

/** Sessions whose last reply text and turn start are remembered. */
const STATE_LIMIT = 64

/** A question and the reply that follows it collapse into one notification. */
const DEDUPE_MS = 5_000

/** Keepalive interval for an idle `EventSource` subscription. */
const HEARTBEAT_MS = 25_000

/** Tool whose call is announced as a question. */
const ASK_TOOL = 'ask_user_question'

/** Row-config defaults. */
const DEFAULTS = {
  replies: true,
  questions: true,
  approvals: true,
  subagents: false,
  excerpt: true,
  sound: 'Glass',
  title: 'DeepSeek Harness',
  minReplySeconds: 0,
  fallback: true,
  suppressWhenFocused: false,
}

/**
 * Read a bounded error description for the Host log.
 * @param {unknown} error - Thrown value.
 * @returns {string} Short message.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message.slice(0, 300)
  return String(error).slice(0, 300)
}

/**
 * Report whether a value is a plain configuration record.
 * @param {unknown} value - Candidate value.
 * @returns {boolean} True for a non-array object.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate the plugin row config, filling defaults.
 * @param {Record<string, unknown> | undefined} config - Row config.
 * @returns {typeof DEFAULTS} Resolved options.
 */
function resolveOptions(config) {
  const raw = isRecord(config) ? config : {}
  const flag = (key) => {
    const value = raw[key]
    if (value === undefined) return DEFAULTS[key]
    if (typeof value !== 'boolean') throw new TypeError(`dsh-notify: config.${key} must be a boolean`)
    return value
  }
  const text = (key, { allowEmpty = true } = {}) => {
    const value = raw[key]
    if (value === undefined) return DEFAULTS[key]
    if (typeof value !== 'string') throw new TypeError(`dsh-notify: config.${key} must be a string`)
    if (!allowEmpty && value.trim() === '') throw new TypeError(`dsh-notify: config.${key} must not be empty`)
    return value
  }
  const seconds = raw.minReplySeconds ?? DEFAULTS.minReplySeconds
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw new TypeError('dsh-notify: config.minReplySeconds must be a non-negative number')
  }
  return {
    replies: flag('replies'),
    questions: flag('questions'),
    approvals: flag('approvals'),
    subagents: flag('subagents'),
    excerpt: flag('excerpt'),
    sound: text('sound'),
    title: text('title', { allowEmpty: false }),
    minReplySeconds: seconds,
    fallback: flag('fallback'),
    suppressWhenFocused: flag('suppressWhenFocused'),
  }
}

/**
 * Collapse a text block into one notification-safe line.
 * @param {string} value - Raw text.
 * @param {number} limit - Maximum length.
 * @returns {string} Single-line text, possibly truncated with an ellipsis.
 */
function line(value, limit) {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  const visible = Array.from(collapsed)
  if (visible.length <= limit) return collapsed
  return `${visible.slice(0, limit - 1).join('').trimEnd()}…`
}

/**
 * Extract the plain text of one assistant message.
 * @param {unknown} message - Message carrying content blocks.
 * @returns {string} Joined text blocks.
 */
function textOf(message) {
  if (!isRecord(message) || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * Quote one string as an AppleScript string literal.
 * @param {string} value - Text to quote (without its own line breaks).
 * @returns {string} Quoted literal.
 */
function appleScriptString(value) {
  const escaped = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
  return `"${escaped}"`
}

/**
 * Start one detached notifier process, trying each candidate executable in turn.
 * @param {readonly string[]} candidates - Absolute paths, then bare names for PATH lookup.
 * @param {readonly string[]} args - Arguments.
 * @param {(error: unknown) => void} onFailure - Called with the first error no candidate survives.
 * @returns {void}
 */
function launch(candidates, args, onFailure) {
  let attempt = 0
  const start = () => {
    const command = candidates[attempt]
    let child
    try {
      child = spawn(command, args, { stdio: 'ignore' })
    } catch (error) {
      onFailure(error)
      return
    }
    child.on('error', (error) => {
      if (error?.code === 'ENOENT' && attempt + 1 < candidates.length) {
        attempt += 1
        start()
        return
      }
      onFailure(error)
    })
    child.unref()
  }
  start()
}

/**
 * Post one notification through the operating system's own notifier.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context for logging.
 * @param {typeof DEFAULTS} options - Resolved options.
 * @returns {{ show: (payload: { subtitle: string, body: string }) => void }} System notifier.
 */
function createSystemNotifier(ctx, options) {
  const platform = process.platform
  let reported = false
  const fail = (error) => {
    if (reported) return
    reported = true
    ctx.logger.warn(`dsh-notify: cannot show a system notification: ${messageOf(error)}`)
  }
  return {
    show({ headline, body }) {
      const summary = line(headline, LINE_LIMIT)
      const message = line(body, LINE_LIMIT)
      if (platform === 'darwin') {
        let script = `display notification ${appleScriptString(message)} with title ${appleScriptString(options.title)}`
        if (summary !== '') script += ` subtitle ${appleScriptString(summary)}`
        if (options.sound !== '') script += ` sound name ${appleScriptString(options.sound)}`
        launch(['/usr/bin/osascript', 'osascript'], ['-e', script], fail)
        return
      }
      if (platform === 'linux') {
        launch(
          ['/usr/bin/notify-send', 'notify-send'],
          ['--app-name', options.title, summary === '' ? options.title : summary, message],
          fail,
        )
        return
      }
      fail(new Error(`platform "${platform}" has no system notifier (macOS and Linux are supported)`))
    },
  }
}

/**
 * Own the page-facing event stream and the two loopback routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {typeof DEFAULTS} options - Resolved options.
 * @returns {{ publish: (payload: object) => boolean, routes: () => Array<object>, dispose: () => void }} Channel.
 */
function createChannel(ctx, options) {
  /** @type {Set<import('node:http').ServerResponse>} */
  const clients = new Set()
  const state = { delivered: 0, lastDeliveryAt: 0 }

  /**
   * Write one already-serialized frame to every attached page.
   * @param {string} frame - Complete SSE frame.
   * @returns {number} Number of pages that received it.
   */
  const broadcast = (frame) => {
    let written = 0
    for (const response of clients) {
      try {
        response.write(frame)
        written += 1
      } catch {
        clients.delete(response)
      }
    }
    return written
  }

  /**
   * Send one notification to every attached page.
   * @param {{ headline: string, body: string }} payload - Notification content.
   * @returns {boolean} True when at least one page received it.
   */
  const publish = ({ headline, body }) => {
    const payload = {
      kind: 'notify',
      title: line(headline, LINE_LIMIT),
      body: line(body, LINE_LIMIT),
      silent: options.sound === '',
    }
    const written = broadcast(`data: ${JSON.stringify(payload)}\n\n`)
    if (written > 0) {
      state.delivered += 1
      state.lastDeliveryAt = Date.now()
      return true
    }
    return false
  }

  /**
   * Answer the stream subscription the Client half holds open.
   * @param {import('node:http').IncomingMessage} req - Request.
   * @param {import('node:http').ServerResponse} res - Response.
   * @returns {void}
   */
  const handleEvents = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.end()
      return
    }
    if (req.method === 'HEAD') {
      res.statusCode = 200
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')
    clients.add(res)
    const hello = { kind: 'hello', suppressWhenFocused: options.suppressWhenFocused }
    try {
      res.write(`data: ${JSON.stringify(hello)}\n\n`)
    } catch (error) {
      ctx.logger.warn(`dsh-notify: cannot greet a page subscriber: ${messageOf(error)}`)
    }
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        clearInterval(heartbeat)
        clients.delete(res)
      }
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
    res.on('close', () => {
      clearInterval(heartbeat)
      clients.delete(res)
    })
  }

  /**
   * Report delivery state without changing it.
   * @param {import('node:http').IncomingMessage} req - Request.
   * @param {import('node:http').ServerResponse} res - Response.
   * @returns {void}
   */
  const handleStatus = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.end()
      return
    }
    const body = JSON.stringify({
      pages: clients.size,
      delivered: state.delivered,
      lastDeliveryAt: state.lastDeliveryAt === 0 ? null : new Date(state.lastDeliveryAt).toISOString(),
      fallback: options.fallback,
      platform: process.platform,
    })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }

  return {
    publish,
    routes: () => [
      { kind: 'exact', path: ROUTE_EVENTS, handler: handleEvents },
      { kind: 'exact', path: ROUTE_STATUS, handler: handleStatus },
    ],
    dispose: () => {
      for (const response of clients) {
        try {
          response.end()
        } catch {
          // A closed subscriber needs no teardown.
        }
      }
      clients.clear()
    },
  }
}

/**
 * Register the notification listeners for this process.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {Record<string, unknown> | undefined} config - Plugin row config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const channel = createChannel(ctx, options)
  const system = createSystemNotifier(ctx, options)

  /**
   * Deliver one notification: the page first, the operating system second.
   * @param {{ headline: string, body: string }} payload - Notification content.
   * @returns {void}
   */
  const notify = (payload) => {
    if (channel.publish(payload)) return
    if (options.fallback) system.show(payload)
  }

  /** @type {Map<string, { startedAt: number | null, text: string }>} */
  const sessions = new Map()
  /** @type {Map<string, number>} */
  const lastSent = new Map()

  /**
   * Read, or create, one session's tracked state.
   * @param {string} id - Session id.
   * @returns {{ startedAt: number | null, text: string }} State.
   */
  const stateOf = (id) => {
    let state = sessions.get(id)
    if (state === undefined) {
      state = { startedAt: null, text: '' }
      sessions.set(id, state)
      if (sessions.size > STATE_LIMIT) sessions.delete(sessions.keys().next().value)
    }
    return state
  }

  /**
   * Report whether this session was notified within the dedupe window.
   * @param {string} id - Session id.
   * @returns {boolean} True when a notification just fired.
   */
  const recentlySent = (id) => {
    const at = lastSent.get(id)
    return at !== undefined && Date.now() - at < DEDUPE_MS
  }

  /**
   * Remember that this session was just notified.
   * @param {string} id - Session id.
   * @returns {void}
   */
  const markSent = (id) => {
    lastSent.set(id, Date.now())
    if (lastSent.size > STATE_LIMIT) lastSent.delete(lastSent.keys().next().value)
  }

  /**
   * Report whether a session belongs to a top-level agent rather than a subagent child.
   * @param {{ header?: { depth?: number, origin?: string } } | undefined} session - Session.
   * @returns {boolean} True when this session's work is user-visible.
   */
  const isTopLevel = (session) => {
    if (options.subagents) return true
    const header = session?.header
    if (header === undefined) return true
    return (header.depth ?? 0) === 0 && header.origin !== 'subagent'
  }

  /**
   * Summarize the questions of one `ask_user_question` call.
   * @param {string} argsJson - Raw tool arguments.
   * @returns {{ planReview: boolean, body: string } | null} Summary, or null when unreadable.
   */
  const questionOf = (argsJson) => {
    let args
    try {
      args = JSON.parse(argsJson)
    } catch {
      return null
    }
    const questions = Array.isArray(args?.questions) ? args.questions.filter(isRecord) : []
    if (questions.length === 0) return null
    const first = questions[0]
    const parts = []
    if (questions.length > 1) parts.push(`${questions.length} questions`)
    if (typeof first.header === 'string' && first.header.trim() !== '') parts.push(first.header)
    if (typeof first.question === 'string') parts.push(first.question)
    const labels = Array.isArray(first.options)
      ? first.options
        .map((option) => (isRecord(option) ? option.label : undefined))
        .filter((label) => typeof label === 'string' && label.trim() !== '')
      : []
    if (labels.length > 0) parts.push(labels.join(' · '))
    const planReview = questions.some((question) => isRecord(question.intent) && question.intent.kind === 'plan-review')
    return { planReview, body: parts.join(' — ') }
  }

  /**
   * Announce one completed turn.
   * @param {{ id: string }} session - Session that ended the turn.
   * @returns {void}
   */
  const announceReply = (session) => {
    if (!options.replies) return
    if (!isTopLevel(session)) return
    const state = stateOf(session.id)
    const startedAt = state.startedAt
    state.startedAt = null
    if (startedAt !== null && options.minReplySeconds > 0
      && Date.now() - startedAt < options.minReplySeconds * 1000) return
    if (recentlySent(session.id)) return
    const body = options.excerpt ? line(state.text, EXCERPT_LIMIT) : ''
    markSent(session.id)
    notify({ headline: 'Reply ready', body: body === '' ? 'The agent finished its turn.' : body })
  }

  /**
   * Announce one question the agent is about to wait for.
   * @param {{ id: string }} session - Session that asked.
   * @param {string} argsJson - Raw tool arguments.
   * @returns {void}
   */
  const announceQuestion = (session, argsJson) => {
    if (!options.questions) return
    if (!isTopLevel(session)) return
    const question = questionOf(argsJson)
    if (question === null) return
    markSent(session.id)
    notify({
      headline: question.planReview ? 'Plan review needed' : 'Question',
      body: question.body,
    })
  }

  /**
   * Announce one pending approval decision.
   * @param {{ id: string }} session - Session whose agent asked.
   * @param {{ toolName?: unknown, reason?: unknown }} event - `approval/asked` data.
   * @returns {void}
   */
  const announceApproval = (session, event) => {
    if (!options.approvals) return
    if (!isTopLevel(session)) return
    const tool = typeof event?.toolName === 'string' ? event.toolName : 'a tool'
    const reason = typeof event?.reason === 'string' ? line(event.reason, EXCERPT_LIMIT) : ''
    markSent(session.id)
    notify({
      headline: 'Approval needed',
      body: reason === '' ? `${tool} needs your decision.` : `${tool}: ${reason}`,
    })
  }

  /**
   * Turn the committed Session log into notifications.
   * @param {{ id: string }} session - Session that appended the event.
   * @param {{ type?: string, data?: Record<string, any> }} event - Committed Session event.
   * @returns {void}
   */
  const onSessionEvent = (session, event) => {
    try {
      switch (event?.type) {
        case 'turn/start': {
          const state = stateOf(session.id)
          state.startedAt = Date.now()
          state.text = ''
          return
        }
        case 'assistant/message': {
          const text = textOf(isRecord(event.data) ? event.data.message : undefined)
          if (text !== '') stateOf(session.id).text = text
          return
        }
        case 'turn/end':
          if (event.data?.reason?.kind === 'completed') announceReply(session)
          else stateOf(session.id).startedAt = null
          return
        case 'tool/call':
          if (event.data?.name === ASK_TOOL && typeof event.data.arguments === 'string') {
            announceQuestion(session, event.data.arguments)
          }
          return
        case 'approval/asked':
          announceApproval(session, event.data ?? {})
          return
        default:
      }
    } catch (error) {
      ctx.logger.warn(`dsh-notify: cannot notify about a Session event: ${messageOf(error)}`)
    }
  }

  ctx.effect(() => {
    const disposers = [
      ...channel.routes().map((route) => ctx.webServer.register(route)),
      ctx.on('session/event', onSessionEvent),
    ]
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (error) {
          ctx.logger.warn(`dsh-notify: cannot unregister a listener: ${messageOf(error)}`)
        }
      }
      channel.dispose()
      sessions.clear()
      lastSent.clear()
    }
  })
}
