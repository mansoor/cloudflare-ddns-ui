# Changelog

All notable changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/)
— while pre-1.0, minor bumps may carry behaviour changes (each is called out below).

Full notes for any release: <https://github.com/mansoor/cloudflare-ddns-plus/releases>

## [Unreleased]

### Added
- **Test suite and CI.** 78 tests over config normalization and its back-compat migrations, secret
  redact/restore, the Cloudflare-IP guard, backup parsing, every DDNS provider's response handling,
  heartbeat request shapes, and the updater rules. Uses Node's built-in runner — no new dependency.
  CI runs them on Node 20 + 22, builds the stylesheet, and builds the Docker image on every PR.
- **Unraid Community Applications template** (`unraid/cloudflare-ddns-plus.xml`) and **TrueNAS SCALE**
  Custom App instructions.
- **`SECURITY.md`** — reporting process and an explicit trust model (secrets are stored in plaintext;
  don't expose the app directly to the internet).
- Project icon (`docs/icon.png`), used by the Unraid template.

## [0.5.0] — 2026-07-19

Milestone release closing out the 0.4.x line.

### Added
- **DDNS providers must pass a Test before joining scheduled runs.** A newly added provider is excluded
  until its Test succeeds, so a half-configured endpoint isn't hit on a timer. Its card shows a
  **needs test** badge and each run records why it was skipped. The order is **Save → Test**; the
  per-provider **Update** button always runs.
- Adding any item (zone, WAF list, channel, heartbeat, DDNS provider, subdomain, URL row) now scrolls it
  into view and focuses its first field, instead of appending silently below the fold.

### Fixed
- WAF **Managed item comment** still defaulted to the pre-rename `cf-ddns-ui` slug; new lists now use
  `cf-ddns-plus`. Existing lists keep their stored comment — rewriting it would orphan the list items
  they've already tagged.

### Upgrade notes
Existing DDNS providers are grandfathered as tested, so updates continue uninterrupted.

## [0.4.12] — 2026-07-19

### Added
- Dashboard IPv4/IPv6 cards show the detection provider in use (`Provider: Cloudflare (trace)`, or `Off`).

### Fixed
- Managed-records and activity-log scroll areas used the browser's default light scrollbar, which clashed
  with Dark and Paper. Both are themed now, and `color-scheme` makes the page scrollbar and native form
  controls follow the theme too.

## [0.4.11] — 2026-07-18

### Added
- **Paper theme** — a third theme alongside Light/Dark/System: warm parchment surfaces, ink-brown text and
  wine-coloured Save buttons. Applied before first paint, so no flash on load.

## [0.4.10] — 2026-07-18

### Added
- Master **default force-update interval** (Settings → Schedule & advanced), with a per-provider
  **Default** checkbox that follows it. Unticking reveals a per-provider interval.

### Changed
- DDNS URL rows (FreeDNS token/URL and Custom URL) split onto two lines on phones.
- Footer is centred on desktop.

### Fixed
- Freshly rendered provider cards could show a placeholder interval instead of the real value.

## [0.4.9] — 2026-07-18

### Changed
- On phones, card action buttons (Delete / Test / Cancel and every **+ Add**) show icons instead of text
  labels, so footers no longer run off the screen. Save keeps a label, shortened to "Save".

## [0.4.8] — 2026-07-18

### Changed
- The force-update interval is now a proper counter with up/down arrows (mobile browsers render no native
  number spinners), and the row fits on one line on a phone.

## [0.4.7] — 2026-07-18

### Added
- **Per-provider force update** — re-send on a schedule (minutes/hours/days) even when nothing changed, so
  free hosts don't expire and records get re-asserted. On by default at 30 days.

### Changed
- **Updates are only sent when something changed** — the IP, or that provider's own settings — for *all*
  DDNS types. Previously only Custom URL skipped; DuckDNS/DynDNS2/FreeDNS were contacted every run
  (~288×/day) and merely relayed the provider's own "no change" reply. Some services ask clients not to
  send redundant updates.

## [0.4.6] — 2026-07-15

### Fixed
- Custom URL providers always reported **updated**, because these services reply `OK` regardless. The app
  now remembers the last IPs sent per provider and reports **unchanged** — skipping the request entirely,
  which is what services like freemyip ask for.

## [0.4.5] — 2026-07-15

### Added
- **Custom URL DDNS provider** — for services that update via a plain GET (freemyip, dynv6, …), with a
  multi-URL list and `{ip}` / `{ip4}` / `{ip6}` placeholders.
- **Cancel on every card** — revert an edit to its last saved state, or discard a card you just added,
  including restoring sub-items you deleted.

## [0.4.4] — 2026-07-13

### Changed
- **Per-channel notification preferences** — each channel picks its own events (failures / IP change /
  successful changes) instead of one global toggle. Existing preferences are copied onto every channel on
  upgrade. Removes the global "Save preferences" control from 0.4.3.

## [0.4.3] — 2026-07-13

### Changed
- **Save settings** moved to sit directly under the settings it's the only save path for.
- Heartbeat `{status}` / `{message}` guidance moved under the URL field, shown only for the Custom type.

## [0.4.2] — 2026-07-13

### Fixed
- The **next update** countdown reset to a full interval on *any* config save. It now only re-arms when
  starting, resuming, or when the interval itself changes.

## [0.4.1] — 2026-07-13

### Fixed
- Mobile: the subdomain row squeezed the name box to a sliver; A / AAAA / Proxied now wrap to a second row.
- Restore: **Upload backup.json** moved above the textarea.

## [0.4.0] — 2026-07-13

First stable 0.4, promoting the 0.3.1–0.3.7 batch. Highlights since 0.3.0:

### Added
- **Reject Cloudflare IPs** (default on) and **managed-record comment tagging**, so purge only ever removes
  records this tool created.
- IP detection: **local/interface**, **Cloudflare DoH** and **static IP** providers; **IDN/punycode** support.
- **Per-subdomain A/AAAA** narrowing under the global switches.
- **Heartbeat monitoring** (Healthchecks.io, Uptime Kuma, Better Stack, custom URL).
- **Config backup & restore**, password-gated, with a typed confirmation to restore.

### Changed
- Dashboard card renamed "Next run" → "Next update".

### Fixed
- A scoped per-item Update no longer wipes the other rows from the dashboard table.

## [0.3.7] — 2026-07-13

### Added
- **Config backup & restore** (Settings → Backup & restore). Pasting a Cloudflare DDNS+ backup into the
  first-run Migrate panel is detected and redirected here.

### Fixed
- A scoped per-item update replaced the whole managed-records table with just its own rows.

## [0.3.6] — 2026-07-13

### Added
- **Cloudflare DoH** and **static IP** detection providers; **IDN/punycode** domain support.

### Changed
- Heartbeat monitors reworked into collapsible cards with per-card Delete / Test / Save.

## [0.3.5] — 2026-07-13

### Added
- **Reject Cloudflare IPs**, **managed-record tagging + safer purge**, **local/interface IP detection**,
  **heartbeat monitoring**, and **per-subdomain A/AAAA**.

## [0.3.4] — 2026-07-12

### Changed
- Navigation polish: menu icons, hover transitions, left-aligned mobile drawer items.

## [0.3.3] — 2026-07-12

### Changed
- Card header badges wrap below the label on mobile; theme control collapses to the active icon.

## [0.3.2] — 2026-07-12

### Changed
- Mobile nav became a slide-out drawer; dashboard cards made more compact.

### Fixed
- Settings save confirmation now reads simply "Saved".

## [0.3.1] — 2026-07-12

### Changed
- First mobile-responsive pass: hamburger nav, managed records as cards, icon sign-out.

## [0.3.0] — 2026-07-12

### Added
- Import flow warns when a token lacks DNS-record permission, instead of failing on the first sync.

## [0.2.1] — 2026-07-12

### Added
- **First-run onboarding** — migrate from upstream `cloudflare-ddns` by pasting or uploading its
  `config.json`, with a per-zone preview and dedupe.

## [0.2.0] — 2026-07-11

First release under the name **Cloudflare DDNS+**.

### Added
- Optional **persistent activity log** (JSONL under `/data`) with a retention window.

### Changed
- Renamed from Cloudflare DDNS UI. Image/package slug is now `cloudflare-ddns-plus`.

---

Releases before 0.2.0 were published under the project's former name (`cloudflare-ddns-ui`) and aren't
listed here; that image stayed frozen at v0.1.8 when the rename happened.

[Unreleased]: https://github.com/mansoor/cloudflare-ddns-plus/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.5.0
[0.4.12]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.4.12
[0.4.11]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.4.11
[0.4.10]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.4.10
[0.4.9]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.4.9
[0.4.8]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.4.8
[0.4.7]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.4.7
[0.4.6]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.4.6
[0.4.5]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.4.5
[0.4.4]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.4.4
[0.4.3]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.4.3
[0.4.2]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.4.2
[0.4.1]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.4.1
[0.4.0]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.4.0
[0.3.7]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.3.7
[0.3.6]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.3.6
[0.3.5]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.3.5
[0.3.4]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.3.4
[0.3.3]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.3.3
[0.3.2]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.3.2
[0.3.1]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.3.1
[0.3.0]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.3.0
[0.2.1]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.2.1
[0.2.0]: https://github.com/mansoor/cloudflare-ddns-plus/releases/tag/v0.2.0
