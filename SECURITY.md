# Security Policy

Sparkmux is a desktop front end for a private tmux server (`tmux -L sparkmux`), with an optional phone and tablet page served from that same machine. This file is how to report a vulnerability, which versions receive fixes, and the boundaries a report is measured against.

## Reporting a vulnerability

Report privately. Please do not file a public GitHub issue for an undisclosed vulnerability.

- [Open a GitHub Security Advisory](https://github.com/darrenkoh/sparkmux/security/advisories/new)
- Email [darrenkoh@gmail.com](mailto:darrenkoh@gmail.com) if GitHub advisories are unavailable

Include:

- Sparkmux version, and whether it came from a GitHub Release, a local build, or `scripts/install.sh`
- Operating system (Apple Silicon macOS or ARM64 Linux) and the tmux version
- The surface: desktop app, `sparkmux serve` or the phone page, the `sparkmux` CLI, or the installer
- What you expected, what happened, and a minimal way to reproduce it
- Who can reach the issue and what they gain

A public issue is fine for a hardening idea that has no exploit.

## What happens next

One person maintains this project. I aim to acknowledge a report within 7 days. When I confirm an issue, I will work on a fix and agree a disclosure date with you before details are published. If we cannot agree on a date, the default is 90 days after the report. I will credit you in the advisory or the changelog unless you ask to stay anonymous.

## Supported versions

Security fixes ship in a new GitHub Release. Upgrade to the latest release. Older tags are not patched in place.

| Version | Security fixes |
| --- | --- |
| Latest GitHub Release | Yes |
| `main` | Fixes land here, then ship in the next release |
| Older releases | No |

## In scope

- The desktop app, the `sparkmux` CLI, and `sparkmux-core`
- `sparkmux serve` and the phone page: the pairing token, the `sparkmux_session` cookie, the bind address, and what a paired or unpaired client can do
- Release artifacts, the updater signature check, and `scripts/install.sh`
- How the app reads local agent transcripts, and how an `ssh` pane is kept off the local `~/.grok`, `~/.claude`, and `~/.gemini` trees
- How a clicked terminal link is opened
- Commands the app sends to its private `-L sparkmux` tmux server

## Out of scope

- tmux itself. Report those upstream.
- Programs running inside a pane, including Grok, Claude, Antigravity, and the shell
- The default tmux server (`-L default`). Sparkmux leaves that server alone.
- Unsigned macOS disk images. Release `.dmg` builds are unsigned, and the README says so. A flaw in the updater signature check is in scope.
- Testing on a machine or account you do not have permission to use

## Safe harbor

Research that follows this policy, stays on systems you are allowed to test, and avoids privacy violations, data destruction, and interruption of anyone else's use is welcome. I will not pursue a legal claim for that research.

## Design boundaries

- The desktop window is a local webview for the account that launched Sparkmux. A vulnerability is a way for someone else, or for untrusted pane output, to leave that window: another account, the default tmux server, a shell command the user did not send, or files belonging to a CLI the pane is not running.
- The app owns `tmux -L sparkmux`. Quitting detaches the control client and leaves that server running.
- Logs, Stats, and Gits read agent transcripts. The follower is not supposed to modify `~/.grok`, `~/.claude`, or `~/.gemini`. Purge removes Sparkmux's own telemetry for a tab and leaves the CLI transcript on disk.
- An `ssh` foreground pane does not follow the local machine's agent transcripts.
- A clicked terminal link must be `http` or `https`, must have a host, and must not include credentials. The app passes that single URL to `/usr/bin/open` or `xdg-open`.
- `sparkmux serve` listens on `0.0.0.0` port `7420` unless you set `--bind` or `--port`. The page requires the pairing token. Treat the printed URL as a secret: anyone who can open it can type into your panes.
- Update Now installs a payload whose signature matches the key in `apps/desktop/src-tauri/tauri.conf.json`.
- `scripts/install.sh` on `main` downloads the latest GitHub Release.
