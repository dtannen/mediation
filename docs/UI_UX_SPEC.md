# Mediation UI/UX Specification

Status: Implementation-Ready
Date: 2026-02-25
Replaces: `desktop/renderer/index.html` (testing-only interface)
Reuse baseline: `/Users/dtannen/Code/commands-com-agent/desktop/renderer/`

---

## 0. Overview

The current `index.html` is a developer testing harness — flat form inputs, raw event logs, and admin-level controls. This spec defines the production party-facing UI: a phase-aware conversation interface that guides each participant through the mediation lifecycle.

**Key principles:**
- The UI shows only what is relevant to the current phase and current user's role. No admin chrome, no raw JSON, no phase-transition buttons. The system drives phase changes automatically based on domain guards; the UI reacts.
- A party can begin private intake immediately after joining — they do not wait for the other party to join first. Intake and joining are independent per-party activities. The system only gates the transition to `group_chat` on both parties being ready.

---

## 1. Tech Stack & Reuse

### From commands-com-agent (copy + adapt)

| Component | Source File | What to reuse |
|---|---|---|
| Message bubbles | `views/agent-chat.js` | Two-sided bubble layout, timestamp formatting, auto-scroll |
| Chat layout shell | `views/agent-chat.js` lines 427-465 | Header + messages + input area flex structure |
| Conversation list | `views/agent-detail.js` lines 367-376 | Split-panel grid (sidebar + thread) |
| Session cards | `views/agent-detail.js` | Card with status dot, preview text, meta line |
| Markdown renderer | `markdown.js` | `renderMarkdownUntrusted()` with full sanitization pipeline |
| Approval modal | `components/room-approval.js` | Overlay + action buttons pattern (for coach-draft review) |
| Timeline events | `components/room-timeline.js` | Timestamped event badges (for system messages) |
| CSS design tokens | `styles/base.css` | `:root` variables, glassmorphism, dark theme |
| Draft preservation | `agent-chat.js` lines 39-50 | `Map`-based textarea draft persistence across re-renders |
| Auto-size textarea | `agent-chat.js` lines 128-132 | `autoSizeTextarea()` function |

### New (mediation-specific)

- Private intake coach conversation view
- Coach-draft compose panel (side drawer)
- Consent settings UI
- Invite/join landing page
- Resolution summary view

### Stack decisions

- **No framework** — vanilla JS/HTML/CSS, consistent with commands-com-agent
- **CSS variables** — extend the existing design token system
- **Electron IPC** — use existing 46-channel manifest in `desktop/ipc/channel-manifest.ts`
- **Module pattern** — one JS module per view, renderer-level state in a central `state.js`

---

## 2. Design Tokens

Extend the commands-com-agent palette for mediation-specific semantics:

```css
:root {
  /* Base (inherit from commands-com-agent base.css) */
  --bg: #0c1017;
  --panel: #151b27;
  --panel-soft: #121720;
  --ink: #e5e7eb;
  --muted: #94a3b8;
  --line: rgba(55, 65, 81, 0.5);
  --brand: #667eea;
  --brand-strong: #764ba2;
  --danger: #ef4444;
  --ok: #10b981;
  --glass-border: rgba(55, 65, 81, 0.4);

  /* Mediation-specific */
  --coach-a: #667eea;          /* Party A coach accent (purple-blue) */
  --coach-b: #f59e0b;          /* Party B coach accent (amber) */
  --mediator: #10b981;         /* Neutral mediator accent (green) */
  --system: #64748b;           /* System messages (slate) */

  --mono: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  --sans: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}
```

---

## 3. Layout

No persistent application shell. Each view owns its full screen. The only shared element is a slim top bar when inside a case:

```
┌──────────────────────────────────────────────────┐
│  ← Back    "Co-founder dispute"         Alex ●   │
├──────────────────────────────────────────────────┤
│                                                  │
│           (view content fills rest)              │
│                                                  │
└──────────────────────────────────────────────────┘
```

- **Dashboard:** No top bar. The dashboard is the root — logo, case list, and action buttons are all part of the view itself.
- **Inside a case:** Slim top bar with `← Back` (returns to dashboard), case topic, and your name/avatar. That's it — no phase stepper, no status bar, no settings gear. The current phase is obvious from the view content itself (you're either chatting with your coach, in the group mediation, or looking at a resolution).

---

## 4. Views

### 4.0 Dashboard (home)

The default landing view after login. The two primary actions in the app — **start a mediation** and **join someone else's mediation** — are both here, alongside the list of cases you're already part of.

```
┌─────────────────────────────────────────────────────────────┐
│ ┌─ Header ───────────────────────────────────────────────┐  │
│ │  [Logo]  Mediation                        [●] Alex [⚙] │  │
│ └────────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Actions ─────────────────────────────────────────────┐  │
│  │                                                       │  │
│  │  [ + New Mediation ]        [ Join from Invite Link ] │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌─ Your Cases ──────────────────────────────────────────┐  │
│  │                                                       │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  Co-founder governance dispute                  │  │  │
│  │  │  ● Mediation in progress   │  You: ready        │  │  │
│  │  │  Blair: intake in progress │  Feb 24            │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │                                                       │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  Office lease renewal terms                     │  │  │
│  │  │  ○ Waiting for other party to join              │  │  │
│  │  │  You: intake complete      │  Feb 22            │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │                                                       │  │
│  │  ┌─────────────────────────────────────────────────┐  │  │
│  │  │  Q4 budget disagreement             ✓ Resolved  │  │  │
│  │  │  Closed Feb 18                                  │  │  │
│  │  └─────────────────────────────────────────────────┘  │  │
│  │                                                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  (empty state when no cases:)                               │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  No mediations yet.                                   │  │
│  │  Start one or join from an invite link above.         │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Two primary actions (always visible at top):**

#### "New Mediation" (create flow)

Clicking `[ + New Mediation ]` expands an inline form:

```
┌─ Start New Mediation ───────────────────────────────┐
│                                                     │
│  Topic:       [ Co-founder governance dispute     ] │
│  Description: [ Need a fair path for decision...  ] │
│                                                     │
│  Your name:   [ Alex   ]                            │
│  Other party: [ Blair  ]                            │
│                                                     │
│  [ Create & Send Invite ]          [ Cancel ]       │
│                                                     │
└─────────────────────────────────────────────────────┘
```

- Fields: topic (required), description (optional), your name, other party's name
- "Create & Send Invite" → `createCase()` via IPC → auto-generates invite link → shows share modal
- After creation, the new case appears at the top of the list and the creator is auto-joined as Party A
- Creator is immediately taken into the case (private intake begins)

#### "Join from Invite Link" (join flow)

Clicking `[ Join from Invite Link ]` expands an inline form:

```
┌─ Join a Mediation ──────────────────────────────────┐
│                                                     │
│  Paste your invite link:                            │
│  [ https://mediate.app/join/case_abc?token=xyz... ] │
│                                                     │
│  ┌─ Preview (shown after paste) ─────────────────┐  │
│  │  Topic: "Co-founder governance dispute"       │  │
│  │  Started by: Alex                             │  │
│  │  Your role: Party B (Blair)                   │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  [ Join Mediation ]                    [ Cancel ]   │
│                                                     │
└─────────────────────────────────────────────────────┘
```

- Paste or type an invite link → auto-parses and shows a preview of the case (topic, who started it, which party slot you'll fill)
- Preview fetched via `desktop:mediation:peek-invite` (read-only, no side effects) or parsed from the token payload
- "Join Mediation" → `joinWithInvite(caseId, partyId, token)` → on success, case appears in your list and you're taken straight into intake

**Share invite modal** (shown after creating a case):
```
┌──────────────────────────────────────┐
│  Invite link created                 │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ https://mediate.app/join/...   │  │
│  └────────────────────────────────┘  │
│  [ Copy Link ]                       │
│                                      │
│  Or send via email:                  │
│  [ blair@company.io     ] [ Send ]   │
│                                      │
│  [ Done ]                            │
└──────────────────────────────────────┘
```

**Case list cards** (reuse session-card pattern from `agent-detail.js`):
- One card per case, sorted by most-recent activity
- Shows: topic, phase as human-readable status, both parties' participation states, date
- Phase color coding: active phases use `--brand`, resolved uses `--ok`, closed uses `--muted`
- Click a card → navigates into the case (renders the appropriate phase view)
- Resolved/closed cards are visually de-emphasized (lower opacity, no status dot glow)

**Case card states:**

| Phase | Card status line |
|---|---|
| `awaiting_join` (you joined, other pending) | "Waiting for [name] to join" |
| `awaiting_join` (you not joined) | "You haven't joined yet" — with inline Join button |
| `private_intake` / `awaiting_join` (you doing intake) | "Your intake in progress" |
| `private_intake` (you ready, other not) | "Waiting for [name] to finish intake" |
| `group_chat` | "Mediation in progress" |
| `resolved` | "Resolved" with checkmark |
| `closed` | "Closed [date]" |

**Deep-link support:** If the app is opened via an invite URL (e.g., clicked from email), the dashboard is bypassed — the join preview + confirmation is shown full-screen as a landing page, then on success the user lands on the dashboard with the new case selected. This is the same join flow, just triggered by URL instead of paste.

**IPC calls:**
- `desktop:mediation:list-cases` — populate case list
- `desktop:mediation:create-case` — create new case
- `desktop:mediation:get-case` — fetch full case data when clicking a card
- `desktop:mediation:peek-invite` — read-only preview of invite link metadata
- `desktop:mediation:join-with-invite` — join a case from invite token

### 4.1 Case Detail (status + actions)

What you see when you click into a case from the dashboard. Shows the current state of the mediation, both parties' progress, and your available action. This is the "home base" for a case — you always land here first, then drill into intake or group chat from here.

```
┌──────────────────────────────────────────────────────┐
│  ← Back                                     Alex ●   │
├──────────────────────────────────────────────────────┤
│                                                      │
│  Co-founder governance dispute                       │
│  Need a fair path for decision ownership and         │
│  accountability.                                     │
│                                                      │
│  ┌─ Participants ─────────────────────────────────┐  │
│  │                                                │  │
│  │  You (Alex)                                    │  │
│  │  ● Intake complete — ready                     │  │
│  │                                                │  │
│  │  Blair                                         │  │
│  │  ○ Hasn't joined yet                           │  │
│  │                                                │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─ Your Intake ──────────────────────────────────┐  │
│  │                                                │  │
│  │  [ Start Your Intake → ]                       │  │
│  │                                                │  │
│  │  You'll have a private conversation with a     │  │
│  │  coach to prepare your perspective before the  │  │
│  │  mediation begins.                             │  │
│  │                                                │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─ Invite ───────────────────────────────────────┐  │
│  │                                                │  │
│  │  Share this link with Blair:                   │  │
│  │  ┌────────────────────────────────────────┐    │  │
│  │  │ https://mediate.app/join/case_abc?...  │    │  │
│  │  └────────────────────────────────────────┘    │  │
│  │  [ Copy Link ]                                 │  │
│  │                                                │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**The view adapts to the current state:**

#### Before intake started

Shows "Start Your Intake" button with a brief explanation of what intake is. Below that, the invite link section (if the other party hasn't joined). Clicking "Start Your Intake" navigates to the private intake chat view (4.2).

#### Intake in progress (you left and came back)

Shows "Continue Your Intake" button with a preview of your last message. Clicking it returns to the coach conversation where you left off.

```
│  ┌─ Your Intake ──────────────────────────────────┐  │
│  │                                                │  │
│  │  [ Continue Your Intake → ]                    │  │
│  │                                                │  │
│  │  Last message: "I think the main issue is..."  │  │
│  │  12 messages · started Feb 24                  │  │
│  │                                                │  │
│  └────────────────────────────────────────────────┘  │
```

#### Intake complete, waiting for other party

Shows your ready status with a checkmark. The other party's status is visible. No action needed — you're waiting.

```
│  ┌─ Your Intake ──────────────────────────────────┐  │
│  │                                                │  │
│  │  ✓ You're ready                                │  │
│  │  Summary saved · [ Review your intake → ]      │  │
│  │                                                │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  Waiting for Blair to finish their intake.           │
│  We'll notify you when the mediation can begin.      │
```

"Review your intake" opens the coach conversation in read-only mode.

#### Both parties ready → group chat available

Shows a prompt to enter the group mediation.

```
│  ┌─ Participants ─────────────────────────────────┐  │
│  │                                                │  │
│  │  You (Alex)          ● Ready                   │  │
│  │  Blair               ● Ready                   │  │
│  │                                                │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  Both parties are ready.                             │
│                                                      │
│  [ Enter Mediation → ]                               │
```

#### Group chat in progress (returning to case)

Shows "Continue Mediation" to re-enter the group chat, plus a summary of recent activity.

```
│  ┌─ Mediation ────────────────────────────────────┐  │
│  │                                                │  │
│  │  [ Continue Mediation → ]                      │  │
│  │                                                │  │
│  │  Last message from Blair: "I think we can..."  │  │
│  │  24 messages · 45 min active                   │  │
│  │                                                │  │
│  └────────────────────────────────────────────────┘  │
```

**Invite section:**
- Shown only when the other party hasn't joined yet
- Displays the invite link with a copy button
- Dismissed once the other party joins

**Participant status labels:**

| State | Display |
|---|---|
| `invited` (not joined) | "Hasn't joined yet" with ○ dot |
| `joined` (intake not started) | "Joined — intake not started" with ● dot |
| `joined` (intake in progress) | "Intake in progress" with ● dot |
| `ready` | "Ready" with ● green dot |

**IPC calls:**
- `desktop:mediation:get-case` — fetch full case state on load
- `mediation-event` — listen for live updates to party states

### 4.2 Private Intake (coach conversation)

**Trigger:** Entered from the case detail view via "Start Your Intake" or "Continue Your Intake". Can begin regardless of whether the other party has joined yet. The case may still be in `awaiting_join` phase at this point. The UI treats intake as a per-party activity, not a phase gate.

Full-screen chat between the party and their private coach LLM.

```
┌─────────────────────────────────────────────────────┐
│ ┌─ Coach Header ─────────────────────────────────┐  │
│ │  Your Coach                    ● Active        │  │
│ │  Private — only you can see this conversation  │  │
│ └────────────────────────────────────────────────┘  │
│                                                     │
│ ┌─ Status Banner (conditional) ──────────────────┐  │
│ │  ℹ The other party hasn't joined yet.          │  │
│ │    You can continue your intake in the          │  │
│ │    meantime — we'll start the group session     │  │
│ │    once everyone is ready.                      │  │
│ └────────────────────────────────────────────────┘  │
│                                                     │
│ ┌─ Messages ─────────────────────────────────────┐  │
│ │                                                │  │
│ │  ┌─────────────────────────────────┐           │  │
│ │  │ Hi Alex. I'm here to help you  │           │  │
│ │  │ prepare for your mediation.     │           │  │
│ │  │ Can you tell me what happened?  │           │  │
│ │  └─────────────────────────────────┘ 2:14p     │  │
│ │                                                │  │
│ │       ┌──────────────────────────────┐         │  │
│ │       │ So basically our co-founder  │         │  │
│ │       │ has been making unilateral   │         │  │
│ │       │ decisions without...         │         │  │
│ │       └──────────────────────────────┘ 2:15p   │  │
│ │                                                │  │
│ │  ┌─────────────────────────────────┐           │  │
│ │  │ I understand. That sounds       │           │  │
│ │  │ frustrating. Let me ask a few   │           │  │
│ │  │ clarifying questions...         │           │  │
│ │  └─────────────────────────────────┘ 2:15p     │  │
│ │                                                │  │
│ └────────────────────────────────────────────────┘  │
│                                                     │
│ ┌─ Input ────────────────────────────────────────┐  │
│ │  [Type your message...          ] [Send]       │  │
│ └────────────────────────────────────────────────┘  │
│                                                     │
│ ┌─ Summary Panel (collapsible) ──────────────────┐  │
│ │  When you feel ready, write a brief             │  │
│ │  summary of your perspective:                   │  │
│ │  [                                            ] │  │
│ │  [                                            ] │  │
│ │                                                 │  │
│ │  ☐ Allow sharing summary with other party       │  │
│ │  ☐ Allow direct quotes (vs paraphrase)          │  │
│ │                                                 │  │
│ │  [ Save Summary & Mark Ready ]                  │  │
│ └─────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**Message bubbles** (reuse from `agent-chat.js`):
- Coach messages: left-aligned, `--mediator` border tint
- Party messages: right-aligned, `--coach-a` or `--coach-b` border tint
- System messages: centered, muted, no bubble (e.g., "Coach is typing...")
- Markdown rendered via `renderMarkdownUntrusted()`
- Auto-scroll to bottom, scroll-lock if user scrolls up

**Status banner (conditional):**
- Shown when the other party has not yet joined: "The other party hasn't joined yet. You can continue your intake in the meantime."
- Dismissed automatically when the other party joins (via `mediation-event`)
- Not shown if both parties are already joined

**Summary panel:**
- Collapsed by default, expand via "I'm ready to summarize" button
- Textarea for free-text summary
- Consent checkboxes map to `CaseConsent.allowSummaryShare` and `allowDirectQuote`
- "Save Summary & Mark Ready" calls `setPrivateSummary()` then `setPartyReady()`
- Once ready, panel shows confirmation badge and chat input is disabled

**Post-ready states (what happens after marking ready):**

| Your state | Other party state | What you see |
|---|---|---|
| Ready | Not joined | "You're all set. Waiting for [name] to join and complete their intake." |
| Ready | Joined, intake in progress | "You're all set. Waiting for [name] to finish their intake." |
| Ready | Ready | Auto-transition to group chat |

The waiting message replaces the chat input area — the coach conversation remains visible and scrollable above it as a read-only transcript of their preparation.

**IPC calls:**
- `desktop:mediation:append-private-message` — send party message
- Coach LLM response comes back via `mediation-event` with new `party_llm` message
- `desktop:mediation:set-private-summary`
- `desktop:mediation:set-party-ready`

**Domain note:** The current phase engine gates `private_intake` on all parties joined. The UI should allow intake activity during `awaiting_join` by calling intake IPC channels directly for the joined party. The phase engine may need a minor adjustment: either (a) allow `appendPrivateMessage` while in `awaiting_join` for joined parties, or (b) treat intake as a per-party concern orthogonal to the case-level phase. Option (a) is the simpler change — relax the phase guard on private message append to allow it in both `awaiting_join` and `private_intake` phases, as long as the party has `joined` status.

### 4.3 Group Chat (`group_chat`)

The main mediation conversation. Three-way chat with mediator, both parties, and optional coach-draft workflow.

```
┌───────────────────────────────────────────────────────────┐
│ ┌─ Group Header ───────────────────────────────────────┐  │
│ │  Mediation: "Co-founder dispute"                     │  │
│ │  Alex (you) ● │ Blair ● │ Mediator 🤖               │  │
│ └──────────────────────────────────────────────────────┘  │
│                                                           │
│ ┌─ Messages ───────────────────────────────────────────┐  │
│ │                                                      │  │
│ │  ┌─ System ──────────────────────────────────────┐   │  │
│ │  │ Mediation session has begun. The mediator     │   │  │
│ │  │ will guide the conversation.                  │   │  │
│ │  └───────────────────────────────────────────────┘   │  │
│ │                                                      │  │
│ │  ┌─ Mediator ────────────────────────────────────┐   │  │
│ │  │ Welcome Alex and Blair. Based on what you've  │   │  │
│ │  │ each shared, I'd like to start by...          │   │  │
│ │  └───────────────────────────────────────────────┘   │  │
│ │                                                      │  │
│ │       ┌──────────────────────────────────────────┐   │  │
│ │       │ Thanks. I want to start by saying that   │   │  │
│ │       │ I think the core issue is...             │   │  │
│ │       └──────────────────── Alex, 2:32p ─────────┘   │  │
│ │                                                      │  │
│ │  ┌─ Blair ───────────────────────────────────────┐   │  │
│ │  │ I appreciate that. From my side, the concern  │   │  │
│ │  │ is really about...                            │   │  │
│ │  └───────────────────────────────────────────────┘   │  │
│ │                                                      │  │
│ └──────────────────────────────────────────────────────┘  │
│                                                           │
│ ┌─ Input Area ─────────────────────────────────────────┐  │
│ │                                                      │  │
│ │  [Type your message...                     ]         │  │
│ │                                                      │  │
│ │  [ Send Direct ]  [ Draft with Coach ▸ ]             │  │
│ └──────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

**Message types and visual treatment:**

| Author | Alignment | Style |
|---|---|---|
| Current user (party) | Right | `--brand` tinted bubble, name hidden (implied) |
| Other party | Left | Neutral bubble, name + timestamp label |
| Mediator LLM | Left, full-width | `--mediator` accent border-left, "Mediator" badge |
| System | Center, no bubble | Muted text, divider style (e.g., "Session started") |

**Two send paths (from spec):**

1. **Send Direct** — `sendDirectGroupMessage(caseId, partyId, text)` — message goes straight to group thread
2. **Draft with Coach** — opens the coach-draft side panel (see 4.4.1)

### 4.3.1 Coach-Draft Side Panel

Slides in from the right when "Draft with Coach" is clicked. Split view: group chat on left (read-only while drafting), coach conversation on right.

```
┌──────────────────────────┬────────────────────────────┐
│  Group Chat (read-only)  │  Draft with Coach          │
│                          │                            │
│  [Messages continue      │  ┌────────────────────┐   │
│   scrolling here but     │  │ What would you like │   │
│   input is disabled]     │  │ to say to the group?│   │
│                          │  └────────────────────┘   │
│                          │                            │
│                          │   ┌─────────────────────┐  │
│                          │   │ I want to propose   │  │
│                          │   │ that we split the   │  │
│                          │   │ responsibilities... │  │
│                          │   └─────────────────────┘  │
│                          │                            │
│                          │  ┌────────────────────┐   │
│                          │  │ That's a good start.│   │
│                          │  │ Consider framing it │   │
│                          │  │ as a question...    │   │
│                          │  └────────────────────┘   │
│                          │                            │
│                          │  ── Suggested Message ──   │
│                          │  ┌────────────────────────┐│
│                          │  │ "What if we tried     ││
│                          │  │  splitting the key     ││
│                          │  │  responsibilities?"    ││
│                          │  └────────────────────────┘│
│                          │                            │
│                          │  [✓ Approve & Send]        │
│                          │  [✎ Edit before sending]   │
│                          │  [✕ Reject & keep drafting]│
│                          │  [← Back to direct send]   │
└──────────────────────────┴────────────────────────────┘
```

**Coach-draft workflow (maps to domain model):**

1. Party clicks "Draft with Coach" → `createCoachDraft(caseId, partyId, initialMessage)`
2. Multi-turn conversation in side panel → `appendCoachDraftMessage(draftId, author, text)`
3. Coach LLM produces suggestion → `setCoachDraftSuggestion(draftId, suggestedText)`
4. Party reviews:
   - **Approve & Send** → `approveCoachDraftAndSend(draftId)` — posts to group
   - **Edit before sending** → opens editable textarea pre-filled with suggestion, then approve
   - **Reject & keep drafting** → `rejectCoachDraft(draftId, reason)` — continue conversation
   - **Back to direct send** → closes panel, returns to normal input

**IPC calls:**
- `desktop:mediation:create-coach-draft`
- `desktop:mediation:append-coach-draft-message`
- `desktop:mediation:approve-coach-draft`
- `desktop:mediation:reject-coach-draft`
- `desktop:mediation:send-direct-group-message`

### 4.4 Resolution (`resolved`)

Shown when the mediator or parties mark the case resolved.

```
┌─────────────────────────────────────────────────┐
│                                                 │
│   ✓ Mediation Resolved                          │
│                                                 │
│   ┌─ Resolution Summary ─────────────────────┐  │
│   │                                          │  │
│   │  "Both parties agreed to establish a     │  │
│   │   formal decision-making framework       │  │
│   │   with defined ownership areas..."       │  │
│   │                                          │  │
│   └──────────────────────────────────────────┘  │
│                                                 │
│   ┌─ Conversation History ───────────────────┐  │
│   │  [Scrollable read-only chat transcript]  │  │
│   └──────────────────────────────────────────┘  │
│                                                 │
│   [ Close Case ]   [ Export Transcript ]        │
│                                                 │
└─────────────────────────────────────────────────┘
```

**Behavior:**
- Resolution statement displayed prominently at top
- Full group chat transcript in read-only scroll view
- "Close Case" → `closeCase(caseId)` (transitions to `closed`)
- "Export Transcript" → downloads plaintext/markdown of group chat

### 4.5 Closed (`closed`)

Terminal state. Minimal view.

```
┌─────────────────────────────────────┐
│                                     │
│   Case Closed                       │
│   "Co-founder governance dispute"   │
│                                     │
│   Resolved on Feb 25, 2026          │
│                                     │
│   [ View Transcript ]               │
│   [ Start New Mediation ]           │
│                                     │
└─────────────────────────────────────┘
```

---

## 5. Component Specifications

### 5.1 Message Bubble

Adapted from `agent-chat.js`. Core rendering function:

```javascript
function renderMessage(msg, currentPartyId) {
  const isOwn = msg.authorPartyId === currentPartyId;
  const isMediator = msg.authorType === 'mediator_llm';
  const isSystem = msg.authorType === 'system';

  // System messages: centered divider
  if (isSystem) {
    return `<div class="msg-system">${escapeHtml(msg.text)}</div>`;
  }

  // Mediator messages: full-width with accent
  if (isMediator) {
    return `
      <div class="msg-bubble msg-mediator">
        <div class="msg-author">Mediator</div>
        <div class="msg-content agent-prose">${renderMarkdownUntrusted(msg.text)}</div>
        <div class="msg-ts">${formatTime(msg.createdAt)}</div>
      </div>`;
  }

  // Party messages: left/right aligned
  const align = isOwn ? 'msg-own' : 'msg-other';
  const name = isOwn ? '' : `<div class="msg-author">${escapeHtml(msg.authorDisplayName)}</div>`;

  return `
    <div class="msg-bubble ${align}">
      ${name}
      <div class="msg-content agent-prose">${renderMarkdownUntrusted(msg.text)}</div>
      <div class="msg-ts">${formatTime(msg.createdAt)}</div>
    </div>`;
}
```

**CSS:**
```css
.msg-bubble {
  max-width: 80%;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid var(--glass-border);
}

.msg-own {
  align-self: flex-end;
  background: rgba(102, 126, 234, 0.12);
  border-color: rgba(102, 126, 234, 0.25);
}

.msg-other {
  align-self: flex-start;
  background: rgba(148, 163, 184, 0.08);
}

.msg-mediator {
  align-self: flex-start;
  max-width: 90%;
  background: rgba(16, 185, 129, 0.06);
  border-left: 3px solid var(--mediator);
}

.msg-system {
  align-self: center;
  color: var(--muted);
  font-size: 0.82rem;
  padding: 6px 0;
}

.msg-author {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 4px;
}

.msg-ts {
  font-size: 10px;
  color: #475569;
  margin-top: 6px;
}
```

### 5.2 Chat Input Area

Reuse auto-sizing textarea and keyboard handling from `agent-chat.js`.

```javascript
function renderChatInput(options = {}) {
  const { placeholder, showCoachDraft, disabled } = options;
  return `
    <div class="chat-input-area ${disabled ? 'disabled' : ''}">
      <textarea
        id="chat-input"
        placeholder="${placeholder || 'Type your message...'}"
        rows="1"
        ${disabled ? 'disabled' : ''}
      ></textarea>
      <div class="chat-input-actions">
        <button class="btn-primary chat-send-btn" ${disabled ? 'disabled' : ''}>Send</button>
        ${showCoachDraft ? '<button class="btn-secondary chat-draft-btn">Draft with Coach ▸</button>' : ''}
      </div>
    </div>`;
}
```

**Behavior:**
- Enter sends, Shift+Enter for newline
- Auto-size to max 120px height
- Draft preserved in `chatDrafts` Map across re-renders
- Disabled state during coach-draft side panel or after marking ready

### 5.3 Participant Status Cards

Used in group chat header and case cards.

```css
.participant {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
}

.participant-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.participant-dot.joined { background: var(--ok); }
.participant-dot.invited { background: var(--muted); }
.participant-dot.ready { background: var(--brand); }
```

### 5.4 Consent Settings

Shown in private intake summary panel. Maps directly to `CaseConsent` domain type.

```html
<div class="consent-settings">
  <label class="consent-checkbox">
    <input type="checkbox" id="consent-share-summary" checked />
    <span>Allow the mediator to share a summary of my perspective with the other party</span>
  </label>
  <label class="consent-checkbox">
    <input type="checkbox" id="consent-direct-quote" />
    <span>Allow direct quotes (otherwise paraphrased only)</span>
  </label>
</div>
```

---

## 6. View Router

Single-page app. Two levels of routing:

1. **Top-level:** Dashboard (no case selected) vs. case detail (case selected)
2. **Case-level:** View determined by case phase + party participation state

```javascript
function resolveView(appState) {
  const { caseData, partyId, pendingInvite, activeSubview } = appState;

  // Deep-link from invite URL (not yet joined) → dashboard with join form pre-filled
  if (pendingInvite && !caseData) return 'dashboard';

  // No case selected → dashboard
  if (!caseData) return 'dashboard';

  // User explicitly drilled into intake or group chat from case detail
  if (activeSubview === 'private-intake') return 'private-intake';
  if (activeSubview === 'group-chat') return 'group-chat';

  // Terminal phases have their own full views
  if (caseData.phase === 'resolved') return 'resolved';
  if (caseData.phase === 'closed') return 'closed';

  // Default: case detail (status + actions hub)
  return 'case-detail';
}
```

Each view is a module exporting `render(container, state)` and `teardown()`.

**Navigation flow:**
- Dashboard → click case card → **case detail** (status hub)
- Case detail → "Start Your Intake" / "Continue Your Intake" → **private intake** (coach chat)
- Case detail → "Enter Mediation" / "Continue Mediation" → **group chat**
- Private intake → `← Back` → **case detail**
- Group chat → `← Back` → **case detail**
- Case detail → `← Back` → **dashboard**
- Opening an invite URL sets `appState.pendingInvite` → dashboard with join form pre-filled → after joining, lands on **case detail**

---

## 7. State Management

Central renderer state module (adapted from commands-com-agent `state.js`):

```javascript
// renderer/state.js
const appState = {
  // Auth
  auth: { status: 'unknown', user: null },

  // Dashboard
  cases: [],                     // Array of case summaries for the list
  createFormExpanded: false,
  joinFormExpanded: false,
  pendingInvite: null,           // { caseId, token, partyId, topic, initiator } from deep-link or paste

  // Current mediation context (null when on dashboard)
  caseId: null,
  partyId: null,
  caseData: null,

  // Chat state
  privateMessages: [],
  groupMessages: [],
  activeDraft: null,             // Current coach-draft in progress

  // UI state
  currentView: null,
  activeSubview: null,         // 'private-intake' | 'group-chat' | null (case detail)
  coachPanelOpen: false,
  summaryPanelExpanded: false,
};

// IPC event listener updates state and triggers re-render
window.mediationDesktop.onMediationEvent((event) => {
  applyCaseUpdate(event);
  renderCurrentView();
});
```

**Draft preservation** (from `agent-chat.js` pattern):

```javascript
const chatDrafts = new Map();    // viewKey -> textarea content
const draftMeta = new Map();     // viewKey -> { messageCount, lastMsgId }

function syncDraft(viewKey) {
  const input = document.getElementById('chat-input');
  if (input) chatDrafts.set(viewKey, input.value);
}

function restoreDraft(viewKey) {
  const input = document.getElementById('chat-input');
  if (input && chatDrafts.has(viewKey)) {
    input.value = chatDrafts.get(viewKey);
    autoSizeTextarea(input);
  }
}
```

---

## 8. IPC Channel Usage

Mapping of UI actions to existing IPC channels from `channel-manifest.ts`:

| UI Action | IPC Channel | Direction |
|---|---|---|
| List all cases | `desktop:mediation:list-cases` | invoke |
| Create new case | `desktop:mediation:create-case` | invoke |
| Get case detail | `desktop:mediation:get-case` | invoke |
| Preview invite link | `desktop:mediation:peek-invite` | invoke |
| Join from invite | `desktop:mediation:join-with-invite` | invoke |
| Send private message | `desktop:mediation:append-private-message` | invoke |
| Save private summary | `desktop:mediation:set-private-summary` | invoke |
| Mark party ready | `desktop:mediation:set-party-ready` | invoke |
| Send direct group msg | `desktop:mediation:send-direct-group-message` | invoke |
| Create coach draft | `desktop:mediation:create-coach-draft` | invoke |
| Append draft message | `desktop:mediation:append-coach-draft-message` | invoke |
| Approve draft | `desktop:mediation:approve-coach-draft` | invoke |
| Reject draft | `desktop:mediation:reject-coach-draft` | invoke |
| Resolve case | `desktop:mediation:resolve-case` | invoke |
| Close case | `desktop:mediation:close-case` | invoke |
| Case state changes | `mediation-event` | listen |
| Auth state | `auth-changed` | listen |
| Gateway events | `gateway-chat-event` | listen |

---

## 9. File Structure

```
desktop/renderer/
├── index.html                  # App shell (header, main, status bar)
├── app.js                      # Bootstrap, IPC listeners, view router
├── state.js                    # Central state management
├── markdown.js                 # Copy from commands-com-agent (sanitized renderer)
├── views/
│   ├── dashboard.js            # Home: case list, create, join from invite
│   ├── case-detail.js          # Case hub: participant status, start/continue actions
│   ├── private-intake.js       # Coach chat + summary (works during awaiting_join too)
│   ├── group-chat.js           # Phase: group_chat (3-way + coach draft panel)
│   ├── resolved.js             # Phase: resolved (summary + transcript)
│   └── closed.js               # Phase: closed (minimal)
├── components/
│   ├── case-card.js            # Case list card (topic, phase, participants)
│   ├── share-invite-modal.js   # Copy link / email invite modal
│   ├── message-bubble.js       # Reusable bubble renderer
│   ├── chat-input.js           # Auto-sizing input with send/draft buttons
│   ├── participant-status.js   # Name + status dot
│   ├── coach-draft-panel.js    # Side panel for drafting with coach
│   ├── consent-settings.js     # Checkbox group for consent
│   └── summary-panel.js        # Collapsible summary editor
└── styles/
    ├── base.css                # Design tokens, resets, typography
    ├── chat.css                # Message bubbles, chat layout
    ├── views.css               # Per-view layouts (invite, waiting, etc.)
    └── components.css          # Phase stepper, consent, panels
```

---

## 10. Interaction Details

### 10.1 Auto-scroll behavior

Reuse from `agent-chat.js`:
- Track if user is "near bottom" (within 24px of scroll end)
- If near bottom: auto-scroll on new messages
- If scrolled up: do NOT auto-scroll, show "↓ New messages" pill at bottom
- Clicking pill scrolls to bottom

### 10.2 Typing indicators

During group chat, show "[Name] is typing..." below the message list when another party's message is in-flight. Fade after 3 seconds of no activity.

### 10.3 Coach-draft panel transitions

- Opens with a slide-in animation from right (300ms ease)
- Group chat shrinks to ~55% width, draft panel takes ~45%
- On close, group chat expands back to full width
- Panel preserves draft state across open/close cycles

### 10.4 Error handling

- Network errors: banner at top of chat ("Connection lost. Reconnecting...")
- Validation errors: inline below the offending input, red text
- LLM timeouts: "Coach is taking longer than expected..." with retry button
- Never show raw error codes or stack traces to users

### 10.5 Responsive behavior

- Minimum window: 960×640 (matches Electron config)
- Below 1100px: coach-draft panel goes full-screen overlay instead of side panel
- Below 960px: stack layout (single column)

---

## 11. Accessibility

- All interactive elements are focusable with keyboard
- Chat messages use `role="log"` with `aria-live="polite"`
- Phase stepper dots have `title` and `aria-label` attributes
- Coach-draft panel uses `role="dialog"` with `aria-modal="true"`
- Color is never the only indicator — dots also use different shapes/sizes by state
- Focus trapped in modal dialogs (draft panel, approval)

---

## 12. Migration Path

### Phase 1: Scaffold
- Create new file structure under `desktop/renderer/`
- Copy `markdown.js` from commands-com-agent
- Copy relevant CSS from commands-com-agent `base.css`, `chat.css`, `agent-log.css`
- Build `app.js` bootstrap with view router and IPC listener wiring

### Phase 2: Views
- Implement views in order: `dashboard` (with create + join flows) → `case-detail` → `private-intake` → `group-chat` → `resolved` → `closed`
- Each view wired to existing IPC channels
- Relax phase guard on `appendPrivateMessage` to allow calls during `awaiting_join` for joined parties
- Test each view against the existing mediation service

### Phase 3: Coach-Draft Panel
- Implement the side-panel draft workflow
- Wire to existing coach-draft IPC channels
- Test multi-turn draft → approve → send flow

### Phase 4: Polish
- Add transitions and animations
- Responsive breakpoints
- Accessibility audit
- Remove old `index.html` testing interface (or move to `desktop/renderer/dev-tools.html`)
