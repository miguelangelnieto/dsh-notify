# Desktop notifications for DeepSeek Harness

Sends a native desktop notification when an agent needs you: when a turn
finishes and is waiting for your next message, when the agent asks you a
question with options, and when an operation waits for a tool approval. Leave
the window in the background during a long turn and still notice the moment
there is something to read.

It observes existing Host events, adds no model requests, no tools, and nothing
to the Session log. The Host half decides *when*; the banner itself is posted by
the page inside the app window, so macOS attributes it to DeepSeek Harness, uses
the app icon, and opens the app when you click it.

## Triggers

The Host half reads committed Session events, not the interactive
question/approval waterfalls: a UI answerer claims those before any listener
registered later in the process can run, so the log is the reliable signal.

| Trigger | Fires when | Banner title |
|---|---|---|
| Reply finished | A turn ends with `completed` (`turn/end`) | `Reply ready` |
| Question | An `ask_user_question` call is logged (`tool/call`), including an exit-plan review | `Question` / `Plan review needed` |
| Approval | An approval prompt is logged (`approval/asked`) while the policy still asks | `Approval needed` |

The reply notification carries the start of the assistant's last text so the
banner is worth reading on its own. An aborted or failed turn is not announced,
subagent work is ignored by default, and a question followed by the reply that
closes the same turn produces one banner instead of two.

## Install

Add this directory as a profile bundle: **Plugins → Add plugin** in the app, or
ask the agent to run the `plugin_manager` tool with `install_bundle` and this
directory's absolute path.

Either route installs the package and selects the bundle. Installing the package
alone with pnpm (`dsh plugin --profile <profile> add <dir>`) is not enough: the
bundle must also be listed under `dsh.profile.bundles` in the profile's
`package.json`, which is what the two routes above do.

The package deliberately keeps the local name `@local/dsh-notify`; rename it before
publishing to a registry. It installs the row `dsh-notify`, so the feature can be
disabled from Plugins without uninstalling the package.

Refresh the Web page once after installing so its client bundle is fetched.

## Configuration

Set these keys on the plugin row in your profile patch:

```yaml
- id: dsh-notify
  config:
    replies: true             # announce a finished turn
    questions: true           # announce an ask_user_question request
    approvals: true           # announce a pending tool approval
    subagents: false          # also announce work done by subagents
    excerpt: true             # put the start of the reply in the banner
    minReplySeconds: 0        # skip replies faster than this ("8" calms a busy session)
    fallback: true            # system notifier when no page is attached
    suppressWhenFocused: false # page only: skip the banner while the window has focus
    sound: Glass              # macOS sound name, "" for silent
    title: DeepSeek Harness
```

Invalid values fail the plugin's activation with a message naming the key, so a
typo never silently disables notifications.

## How a banner is delivered

The Host half detects the events; the banner is posted by whichever half can
carry the app's identity:

- **Page attached** — the Client half keeps an `EventSource` subscription open
  on the loopback route `/dsh-notify/events` and calls `new Notification()`
  itself. The banner is then attributed to **DeepSeek Harness**, uses the app
  icon, and a click brings the app forward. This is the normal Desktop case.
- **No page attached** — the Host falls back to `osascript` on macOS or
  `notify-send` on Linux, unless `fallback` is `false`. Those banners are
  posted by the system script runner, so macOS lists them under Script Editor.

`/dsh-notify/status` on the same origin reports which path is live
(`pages`, `delivered`, `lastDeliveryAt`). Both routes are loopback-only, like
the rest of the Host HTTP surface.

The Web page must be reloaded once after installing the bundle or changing the
Client half, because the page's module graph is built at load time. After that,
the page rejoins the stream on its own when the Host plugin is reloaded.

## Platforms

- **macOS** — native banner through the page; `osascript` + Notification Center,
  listed under Script Editor, as the fallback.
- **Linux** — native banner through the page; `notify-send` as the fallback.
  Sounds come from the desktop environment.
- **Windows** — the page path works inside the Desktop app; the Host fallback is
  not implemented and the Host log records one warning.

## Limitations

- Nothing is delivered while DeepSeek Harness is not running, and no history of
  missed notifications is kept.
- The page banner and the fallback do not know whether you are looking at the
  window unless `suppressWhenFocused` is enabled; `minReplySeconds` and
  `replies: false` reduce the volume.
- Every open page posts its own banner, so two windows on the same session show
  the same notification twice.

## Files

| File | Purpose |
|---|---|
| `index.js` | Host plugin: Session observers, text extraction, loopback stream, system fallback |
| `client.js` | Client half: the `EventSource` subscription and the banner itself |
| `cordis.patch.yml` | Bundle patch that inserts the `dsh-notify` row |
| `locale/*.json` | Plugin Manager title, description, and detail document |
| `docs/DETAIL.md`, `docs/DETAIL.es.md` | Single-image detail pages |
| `icon.svg` | Plugin icon |

## License

MIT
