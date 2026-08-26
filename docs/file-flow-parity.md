# File lifecycle parity

Baseline: official master `6ff27fe1fa9bc6a32dcc7b97efeaeda901aad2db`.

Client reference (read-only): native frontend remote `master`
`7c4bd34a7837eb0a19dc5c520290338b0719fcc0`, confirmed by a direct remote query
on 2026-08-26. Only the Arkme plugin is changed; no client or DSH source is changed.

## Product reference, not internal capability names

The client input toolbar has exactly two actions: 添加照片和文件 and 写长文
(`features/chat/presentation/input_toolbar.dart`, lines 714–731 at the reference).
Local file staging is an implementation detail, not a 本地附件 menu or library.
The client preview uses 接收文件 / 打开 in the file panel and a download icon at
the bottom; it does **not** have an 另存为 button. The icon invokes a destination
picker before receiving/copying bytes (`features/file/presentation/desktop/desktop_image_preview.dart`,
lines 999–1054, 1485–1554 and 2214–2247).

The bottom download icon is visible **before reception**, while receiving and
after reception, unless that page has already been saved successfully in the
current preview. This condition is independent of the original-file cache
(`desktop_image_preview.dart`, lines 99–112 and 2214–2247;
`test/features/file/desktop_image_preview_open_file_test.dart`, lines 357–379).
The center action changes from 接收文件 to progress to 打开. These statements
describe the remote desktop source, not a driven native-app acceptance test.

File icons use the user-selected **B: Untitled UI File Icons / Solid** set,
pinned to `@untitledui/file-icons@0.0.9`. All 12 SVGs retain upstream geometry
and default colors; see [asset provenance and license](file-icon-licenses.md).
This intentionally replaces the previous native-client assets. The shared icon
keeps MIME-first classification, adding a dedicated DMG icon; Markdown uses
the same set's code icon and unknown files its empty icon. Drafts use 32px,
message/search cards 40px, and the information panel 64px. The Solid preview
icon is intentionally smaller than the previous 120px native-style sizing,
following visual feedback; card/draft sizes and transfer actions are unchanged.
Assets are embedded
in the client bundle, with no external image requests or new dependency.
This is UI-only: Host, SDK and Tools are N/A for this icon change because no
business capability, transfer logic or button visibility rule changes.

| User step | Plugin behavior following the client |
| --- | --- |
| Add files | Existing picker, clipboard files or drop; prepare locally, spinner in add button |
| Pending attachments | Preview/remove and drag order; keyboard Alt+arrows without extra visible controls |
| Send | Accept a fixed message with attachments, clear that draft, allow the next input while uploading |
| Upload | Per-file overlay/progress; completing capped at 99%; failure removes a stale progress overlay |
| Retry | Keep the message identity and already uploaded siblings; never overwrite a newer draft |
| Open a remote file | File information panel with 接收文件; share reception progress with its message card |
| Open a cached file | Reuse original bytes; Markdown uses the existing public MarkdownText renderer |
| Download | Client download icon; native browser picker first where supported, cancellation has no download side effect |
| Search | Existing file scene; reuse the same file card, receiver and viewer |

The retry/status UI is a plugin recovery adaptation, not a claim that every
client surface has an identical retry control. Unknown server acknowledgement
is reconciled against recent messages and is never blindly resent with new IDs.

## Contract before implementation

Select/import prepares account-bound local files only. Accepting a send persists
the message and its local references before releasing the composer. Cloud upload
progress belongs to message attachments; uploaded bytes are not a sent message.
Retries retain successful assets and the original record/relation identifiers.
An uncertain message acknowledgement must not be silently retried with new IDs.

Drafts, messages and file search share a file viewer. Original-file reception is
distinct from browser download/save; a thumbnail is never an original fallback.
File search uses existing scene 4. Existing upload()/sendRich() consumers retain
their synchronous completion contract.

| Consumer | Required implementation | Verification |
| --- | --- | --- |
| Host | Single account-bound file owner: local staging, durable send state, upload progress, original reception | Owner and route failure/recovery tests |
| UI | Local attachment strip, preview/reorder/remove, optimistic files, per-file progress, retry; shared viewer and search | Interactive and rendering tests, isolated Web acceptance |
| SDK | Public typed capabilities, stage/send/status/retry/receive; abortable polling and old-host detection | External consumer compile and contract tests |
| Tools | Authorized opaque file references, status and explicit-user-write send/retry; no arbitrary filesystem reads | Formal catalog/grant registration and official DSH session invocation |

DSH public seam: WebServer.register() owns HTTP response lifecycle and returns a
disposer. Existing Arkme HTTP adapters remain responsible for Origin/auth checks.
DSH attachment v1 supports images only, not generic files. No private DSH imports,
native open commands or new remote upload/search services are introduced.

## Acceptance

- Selection performs no cloud upload; importing failure preserves valid siblings.
- Local acceptance releases input; each file has actual upload progress capped
  below completion until complete-upload succeeds.
- Partial upload failure retains completed assets; message failure never replaces
  a newer draft; source/account changes cannot rebind a pending send.
- Same record ID is idempotent; uncertain acknowledgement is shown explicitly.
- Original reception is shared, validates length, and never promotes partial data.
- Cache/staging references remain account-bound and do not expose paths or URLs.
- Browser download fallback reports only handoff, never unverified disk-save success.
- With a supported save picker, success is reported only after the writable file closes.
- Feature remains plugin-only; running user profiles are not replaced.

## Verification and remaining boundaries

Typecheck, full tests (1855 passed, 5 skipped) and build passed on macOS,
including the B / Solid icon replacement. File icon tests pin all 12 SVG hashes,
check inactive/self-contained assets, retain MIME precedence and verify the
shared draft/card/preview mapping, including DMG. No new Host, SDK or Tool
behavior is introduced by this visual correction.

The file viewer uses a 64px icon and places its close control inside the
top-right corner, with a 32px hit target and 12px inset. Information and content
views both reserve space above their content. Click and Escape dismissal remain
covered; the latter stops propagation so a parent detail view stays open.

The mounted message view now retains its last usable attachment display when
the Host explicitly reports a media lookup failure for the same record version.
It keeps the existing failure notice and replaces references on recovery. It
does not retain media across source/record changes, unknown/newer versions,
deleted records, or a successful response that removes attachments. The
regression sequence (complete, unavailable, recovered) formerly rendered
attachment counts `1 -> 0 -> 1`; it now renders `1 -> 1 -> 1`. This reproduces
one deterministic failure path, not every possible live intermittent symptom.

Native copy remains blocked: the desktop reference's `_copyImage` first calls
`Pasteboard.writeFiles`, with an image fallback (lines 956–997). It copies a
file, not its name or a URL. DSH rc.7 exposes `writeClipboard(text: string)`;
the inspected browser bridges cover app updates/notifications/calls, not native
file clipboard writes. Standard browser clipboard formats are not an
equivalent OS file-list contract. No shell-on-Host workaround, misleading
copy-name fallback, or nonfunctional copy button is added. A client-side native
file-clipboard bridge with explicit permission is needed for full parity.
Owner/SDK route tests cover account isolation, Origin, range reads, local staging,
durable identity, partial upload failure, unknown acknowledgement, cache reuse,
truncated reception, save cancellation and failed disk writes. UI tests also
cover original-menu-only, drag order, shared card reception, formatted Markdown
and the absence of invented file-library/Save-As controls.

An isolated official DSH installation successfully exposed all six file tools
to an actual persisted agent session, which called the capabilities-only tool
through the real Host owner. A separate external consumer compiled against the
public SDK, read capabilities and disposed its subscription. These checks do not
prove authenticated upstream upload/send behavior. The interactive fixture uses
real plugin components and file owner, but simulated upstream upload/send ports;
it never sends to a real user's conversation.

Still **not full native-client parity**:

- The Web plugin cannot assume a native bridge for opening a file in an OS
  application or copying an OS file to the clipboard. The inspected public
  clipboard primitive accepts text, and the existing Arkme desktop bridge is
  update-specific. Do not use arbitrary shell commands or open files on a remote
  Host as a substitute for opening on the user's computer. Office/unsupported
  formats explicitly require download then local opening; archives require
  manual extraction. A supported desktop file bridge needs separate scope.
- Browser save dialogs, clipboard file availability, video codecs and PDF viewer
  support depend on the browser. Native OS dialogs and Windows/Linux behavior
  have not been validated. The current receive/preview presentation is not a
  pixel-identical client clone.
- File size remains bounded by Host configuration (default 100 MiB); image limit
  is at most 50 MiB and attachment limit is 9. Do not promise the client's 200 MiB
  non-image limit or dynamic VIP quota without an authoritative capability.
- Real-account upload, private/group/self/topic delivery, weak-network behavior
  and the full native client reference flow still require end-to-end acceptance.
- Native client code was inspected at the remote reference; the Flutter client
  itself was not driven through this flow. Passing plugin tests is not proof
  that the two products are completely aligned.
