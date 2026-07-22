---
name: herdr
description: "Control herdr via CLI (unix socket): inside-pane multiplexing when HERDR_ENV=1, plus host-side agent list/focus/notify and Stream Deck (OpenDeck on Linux). Use for herdr pane/workspace control, agent status, or Elgato Stream Deck + stream-deck-herdr-plugin on shuvdev."
---

# herdr — agent skill

**Canonical source:** `~/repos/herdr/SKILL.md` (this file). Catalog path `~/repos/shuvbot-skills/skills/devops/herdr/SKILL.md` is a symlink here. Local extras live beside the symlink: `references/` and `scripts/`.

**Scope (verified herdr 0.7.5):** Socket CLI works from any shell on PATH — Hermes desktop, SSH, cron, etc. You do **not** need `HERDR_ENV=1` for list/read/wait/agent/notification against known ids.

- **`HERDR_ENV=1`** means *this process is a herdr-managed pane*. Use it to treat the calling pane as "you", split relative to yourself, and rely on env-injected session context.
- **Without `HERDR_ENV`:** host-side observer. Prefer `herdr agent list|get|read|focus|prompt|send-keys|wait|start` and id-targeted `pane read` / `pane wait-output` / `workspace list`. Do **not** assume `pane current` / `focused:true` is your shell — that is the human-focused herdr UI state.
- Stream Deck / OpenDeck: `references/stream-deck-opendeck-linux.md` (resolved next to the catalog symlink).

When inside herdr (`HERDR_ENV=1`), you are a pane in a terminal-native agent multiplexer. Workspaces, tabs, and panes each run a real process — shell, agent, server, or log stream — and the cli controls them over the local unix socket.

## Learn the current CLI

The installed binary is the authority for command syntax. Start with:

```bash
herdr --help
herdr --version
```

Then print the relevant command group by running the group without a subcommand:

```bash
herdr agent
herdr pane
herdr workspace
herdr tab
herdr worktree
herdr terminal
herdr notification
herdr integration
herdr session
```

Do not run bare `herdr` for discovery; it launches or attaches the TUI. Do not probe a mutating nested command by omitting arguments. Commands such as `herdr workspace create` are valid with defaults and will execute.

Most control commands return JSON. Read identifiers and state from those responses instead of predicting them.

## Concepts

- **workspaces** — project contexts; each has one or more tabs
- **tabs** — subcontexts inside a workspace; each has one or more panes
- **panes** — terminal splits; each runs its own process
- **agents** — recognized coding-agent occupants of panes

Public IDs are opaque stable handles:

- workspace: `w1`
- tab: `w1:t1`
- pane: `w1:p1`

Closed tab and pane IDs are not reused. A pane moved into another workspace receives a new workspace-qualified pane ID. After `pane move`, continue with `.result.move_result.pane.pane_id` or the live agent name.

Agent status values: `idle`, `working`, `blocked`, `done`, `unknown`.

- `idle` — ready for input; tab has been seen in the focused Herdr UI
- `done` — same underlying idle state after unseen background work finishes
- `blocked` — approval or question UI
- `unknown` — agent present but not confidently classified; does not prove completion

Focusing the tab or targeting the pane/agent with a focus command marks it seen. CLI reads do not.

## Discover state

```bash
herdr status
herdr agent list
herdr pane list
herdr workspace list
```

Inside herdr (`HERDR_ENV=1`):

```bash
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
herdr pane current --current
herdr pane list --workspace "$HERDR_WORKSPACE_ID"
herdr agent list
```

Inside herdr, the pane with `focused:true` is usually yours. Outside, `focused:true` is whatever the UI has focused — use `agent list` / explicit ids, not "current means me".

## Agent surface (0.7.5 native agent CLI)

Agent commands control the recognized coding agent currently occupying a pane. They accept either a **unique live agent name** or the **pane ID currently hosting that agent**. They do not accept terminal IDs or bare agent-kind labels. Names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live agents. A name follows the current pane occupant and is cleared when that agent exits, is released, or is replaced.

```bash
herdr agent list
herdr agent get <target>
herdr agent read <target> [--source visible|recent|recent-unwrapped|detection] [--lines N] [--format text|ansi]
herdr agent prompt <target> <text> [--wait] [--until STATUS]... [--timeout MS]
herdr agent send-keys <target> <key> [key ...]
herdr agent wait <target> [--until STATUS]... [--timeout MS]
herdr agent focus <target>
herdr agent rename <target> <name>|--clear
herdr agent attach <target> [--takeover]
herdr agent start <name> --kind KIND --pane ID [--timeout MS] [-- <agent-args...>]
herdr agent explain <target> [--json|--verbose]
```

Kinds (from `herdr agent`): `pi|claude|codex|gemini|cursor|devin|agy|cline|omp|mastracode|opencode|copilot|kimi|kiro|droid|amp|grok|hermes|kilo|qodercli|maki`

### Start and coordinate an agent (inside HERDR_ENV=1)

Default to a sibling pane in the current tab and the current working directory. Do not create a workspace, tab, worktree, or different cwd unless the user explicitly requests that topology or location.

```bash
herdr pane layout --pane "$HERDR_PANE_ID"
herdr pane split --current --direction right --cwd "$PWD" --no-focus
```

Read the new pane ID from `.result.pane.pane_id`. The target pane must be an available shell at its interactive prompt.

```bash
herdr agent start reviewer --kind codex --pane <returned-pane-id>
herdr agent start reviewer --kind codex --pane <returned-pane-id> -- <agent-args...>
```

`agent start` returns only after Herdr detects the expected agent in the same pane and considers it ready. Default startup timeout is 30s. It never creates, splits, or moves layout.

```bash
herdr agent prompt reviewer "Review the current diff and report only actionable findings." --wait --timeout 120000
```

`agent prompt` atomically submits text + Enter while honoring live bracketed-paste mode. With `--wait`, it waits for the first settled `idle`, `done`, or `blocked` state. A prompt from a non-working state must produce a lifecycle change within five seconds or Herdr returns `agent_prompt_stalled`.

```bash
herdr agent wait reviewer --until blocked --timeout 120000
herdr agent send-keys reviewer esc
herdr agent send-keys reviewer ctrl+c
herdr agent get reviewer
herdr agent read reviewer --source recent-unwrapped --lines 120
```

If a wait fails or returns `blocked`, inspect `agent get` and `agent read` before sending more input. Use the pane surface only when raw terminal control is intentional.

**Breaking vs older skill text:** `agent send` → `agent send-keys` / `agent prompt`. Top-level `wait` → `agent wait` / `pane wait-output`. `agent start` now requires `--kind` and an existing `--pane` (no `--cwd`/`--split` on start).

## Run an ordinary command in another pane

```bash
herdr pane split --current --direction right --cwd "$PWD" --no-focus
herdr pane run <returned-pane-id> "just test"
herdr pane wait-output <returned-pane-id> --match "test result" --timeout 120000
herdr pane read <returned-pane-id> --source recent-unwrapped --lines 120
```

Read sources:

- `visible` — currently rendered viewport
- `recent` — recent rendered output, including soft wraps
- `recent-unwrapped` — soft wraps joined; prefer for logs/transcripts
- `detection` — bottom-buffer snapshot used for agent detection

Use `--format ansi` when colors/styling are evidence. If increasing `--lines` does not reveal more of a completed agent response, the agent is probably on the alternate screen — ask it to write Markdown to a temp file and reply with the path, then read the file.

## Host-side agent control (any shell)

Preferred entrypoint when not inside a pane (e.g. Hermes desktop):

```bash
herdr status
herdr agent list
herdr agent get <name-or-pane>
herdr agent read <name-or-pane> --source recent-unwrapped --lines 40
herdr agent focus <name-or-pane>          # focuses inside herdr; does not raise Ghostty/window
herdr agent prompt <name-or-pane> "text" --wait --timeout 120000
herdr agent send-keys <name-or-pane> esc
herdr agent wait <name-or-pane> --until idle --timeout 60000
herdr agent explain <name-or-pane>
herdr notification show "Title" --body "..." --sound request|done|none
```

To start an agent from outside: create/locate an available shell pane first (`workspace`/`tab`/`pane` commands), then `herdr agent start <name> --kind KIND --pane <pane-id>`.

**Socket path:** `HERDR_SOCKET_PATH` override, else confirm with `herdr status` → `server.socket` (typically `~/.config/herdr/herdr.sock`). Client socket: `~/.config/herdr/herdr-client.sock`.

## Tabs and workspaces

```bash
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --label "logs"
herdr tab rename w1:t2 "logs"
herdr tab focus w1:t2
herdr tab close w1:t2
herdr workspace list
herdr workspace create
```

## Safety and coordination

- Use `--no-focus` for background work unless the user asked to switch context.
- Use `--current`, an explicit pane ID, or a unique agent name. Do not rely on another client's focused pane.
- Parse IDs from JSON responses. Do not derive them from sidebar order or examples.
- Do not close workspaces, tabs, panes, or sessions you did not create unless the user explicitly asked.
- Never run `herdr server stop` from an active session unless the user explicitly intends to stop the server and its pane processes.
- Never kill the main Herdr process. Use named test sessions for experiments that need an isolated server.
- CLI server errors are JSON on stderr with exit status 1. CLI syntax errors exit with status 2.

## Stream Deck on Linux (shuvdev)

Elgato has **no official Linux app**. Use **[OpenDeck](https://github.com/nekename/OpenDeck)** (`opendeck-bin` on Arch) + **[stream-deck-herdr-plugin](https://github.com/timvdhoorn/stream-deck-herdr-plugin)** (clone at `~/repos/stream-deck-herdr-plugin`).

Full install, manifest `linux` platform, Hyprland focus env vars, rebuild loop, **key SVG typography**, and **agent-count troubleshooting**: **`references/stream-deck-opendeck-linux.md`** (rendering detail: **`references/stream-deck-key-rendering.md`**). Quick layout check: **`scripts/verify-stream-deck-herdr-layout.sh`**.

These paths resolve next to the catalog symlink at `~/repos/shuvbot-skills/skills/devops/herdr/`.

```bash
~/repos/stream-deck-herdr-plugin/scripts/install-opendeck.sh
```

Plugin dir: `~/.config/opendeck/plugins/dev.timvdhoorn.herdr-agents.sdPlugin`. Logs: `~/.local/share/opendeck/logs/plugins/dev.timvdhoorn.herdr-agents.sdPlugin.log`. Enable **developer** in OpenDeck settings when loading unpacked plugins.

**Launch OpenDeck on shuvdev:** `bash ~/.local/bin/opendeck-hidpi` or app menu (not bare `opendeck`). **shuvdev fork:** `PAGE_SIZE=8`, inspector Slot 1–8 — **`references/stream-deck-opendeck-linux.md`** § Pager & Agent Slot. **Key label typography / SVG font bugs:** **`references/stream-deck-key-rendering.md`**.

**shuvdev defaults:** Ghostty window title `herdr` for raise-on-key (`HERDR_DECK_HYPRLAND_TITLE`); multiple Ghostty windows — prefer title over class. udev: `/etc/udev/rules.d/40-streamdeck.rules` (XL `0fd9:008f` included).

**Hermes on shuvdev:** disable macOS `computer_use` / cua-driver — see `hermes-agent-local-patches` → `references/disable-computer-use-linux.md` (browser/shuvgeist remain the desktop path).

## shuvdev plugins (ghui, hunk, file viewer)

Installed community/local plugins and **`prefix+*` keybindings** (ghui `prefix+g`, hunk `prefix+d`, file viewer `prefix+f`, etc.): **`references/shuvdev-plugin-keybindings.md`**.

## Filing herdr bugs

Local dev forks (e.g. `Latitudes-Dev/herdr`) commonly have **GitHub Issues disabled** even though upstream (`ogulcancelik/herdr`) has them enabled. Check before trying to file:

```bash
gh api repos/<owner>/<repo> --jq '.has_issues'
```

If the fork's issues are disabled and the bug is stock/upstream behavior (not something the fork's own patches changed), file against upstream instead. Follow upstream `CONTRIBUTING.md` / bug template only.

**Never open a PR against upstream without the user's explicit approval first.**

## Known client-compatibility: Kitty graphics over non-Kitty SSH clients

herdr renders UI via the Kitty Graphics Protocol. SSH clients that don't implement it (e.g. **Terminus/Termius on iOS**) echo raw bytes as garbage. Signature: repeating base64-looking chunks interleaved with `Ga=p,i=...`. This is client incompatibility, not session corruption. Upstream: [ogulcancelik/herdr#1104](https://github.com/ogulcancelik/herdr/issues/1104).

Pixel dimensions come only from the SSH client's `pty-req`/`window-change` packets — no `sshd_config` fix. Prefer a client that reports pixel size, or skip Kitty graphics paths for that session.
