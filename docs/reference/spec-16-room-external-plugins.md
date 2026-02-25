# External Room Plugins

## Problem

Adding a new room type today requires changes to four places in the main repo:

1. **`desktop/lib/room-contracts.js`** — add type to `SUPPORTED_ORCHESTRATOR_TYPES`, optionally add limit overrides to `ORCHESTRATOR_LIMITS`
2. **`desktop/room/plugin-registry.js`** — add the factory to the hardcoded `PLUGIN_MAP`
3. **Plugin file** — create `desktop/room/my-plugin.js`
4. **`desktop/renderer/views/room-create.js`** — add option to the type selector dropdown

This means third parties cannot create new room types without forking the repo.

## Desired Behavior

A developer drops a plugin directory (containing `manifest.json` + `index.js`) into `~/.commands-agent/room-plugins/`. On startup, the system discovers it, validates the manifest before importing any code, and makes it available in the room creation UI — no changes to the main repo.

## Architecture

### Plugin Structure

Each plugin is a directory that contains:

1. **`manifest.json`** (required for external plugins) — A non-executable JSON file containing all plugin metadata. This is the artifact validated **before** any code is imported. Built-in plugins may embed their manifest in code; external plugins **must** provide this file.
2. **`index.js`** — The plugin module, exporting `{ manifest, createPlugin() }`. The exported `manifest` must match the `manifest.json` contents exactly (enforced post-import).

Together these form the **single canonical contract** for both built-in and external plugins.

#### `manifest.json` (required for external plugins)

This file is read and schema-validated **before** any code is imported. It is the pre-import trust boundary.

```json
{
  "id": "my_custom_room",
  "name": "My Custom Room",
  "version": "1.0.0",
  "orchestratorType": "my_custom_room",
  "description": "One-line description for the create form",
  "supportsQuorum": false,

  "dashboard": {
    "panels": []
  },

  "limits": {
    "maxCycles": { "default": 10 },
    "maxTurns": { "default": 80, "min": 3, "max": 1000 },
    "llmTimeoutMs": { "default": 300000, "max": 600000 },
    "turnFloorRole": "worker",
    "turnFloorFormula": "1 + N"
  },

  "roles": {
    "required": ["worker"],
    "optional": [],
    "forbidden": ["implementer"],
    "minCount": { "worker": 1 }
  },

  "endpointConstraints": {
    "requiresLocalParticipant": true,
    "perRole": {}
  },

  "display": {
    "typeLabel": "My Custom Room",
    "cycleNoun": "Execution",
    "reportTitle": "My Custom Room Report",
    "activityMessages": {
      "idle": "Waiting...",
      "fanOut": "Workers executing tasks",
      "singleTurn": "Worker executing task",
      "synthesis": "Processing results",
      "planning": "Planning tasks"
    },
    "defaultRoster": [
      { "role": "worker", "displayName": "Worker 1" },
      { "role": "worker", "displayName": "Worker 2" }
    ],
    "defaultAddRole": "worker"
  },

  "report": {
    "summaryMetrics": ["taskBoard"],
    "table": {
      "metricKey": "taskBoard",
      "columns": [
        { "key": "task", "label": "Task" },
        { "key": "assignee", "label": "Worker" },
        { "key": "status", "label": "Status" },
        { "key": "deps", "label": "Deps" },
        { "key": "cycle", "label": "Cycle" }
      ]
    }
  }
}
```

**`supportsQuorum`** (boolean, optional — defaults to `false`): Declares whether the room type supports quorum-based decision making. When `true`, the runtime will parse `payload.quorum` via `parseQuorum()` during room creation. Currently only `war_room` sets this to `true`. External plugins that implement quorum logic in their lifecycle hooks should set this field.

**Example: `war_room` manifest with quorum support:**

```json
{
  "id": "war_room",
  "name": "War Room",
  "version": "1.0.0",
  "orchestratorType": "war_room",
  "description": "Parallel task execution with optional quorum decisions",
  "supportsQuorum": true,
  "limits": {
    "maxCycles": { "default": 10 },
    "maxTurns": { "default": 80, "min": 3, "max": 1000 },
    "turnFloorRole": "worker",
    "turnFloorFormula": "2 + N"
  },
  "roles": {
    "required": ["worker"],
    "optional": [],
    "forbidden": ["implementer"],
    "minCount": { "worker": 2 }
  }
}
```

#### `index.js` (plugin module)

The exported `manifest` must be identical to `manifest.json`. The registry verifies this post-import (deep equality check). This redundancy ensures the runtime manifest matches the pre-validated artifact.

```js
// ~/.commands-agent/room-plugins/my-plugin/index.js
import manifest from './manifest.json' with { type: 'json' };

export default {
  manifest,

  // Required: factory function (same interface as existing plugins)
  createPlugin() {
    return {
      init(ctx) { /* ... */ },
      onRoomStart(ctx) { /* ... */ },
      onFanOutComplete(ctx, responses) { /* ... */ },
      onTurnResult(ctx, turnResult) { /* ... */ },
      onResume(ctx) { /* ... */ },
      onEvent(ctx, event) { /* ... */ },
      refreshPendingDecision(ctx, decision) { /* ... */ },
      shutdown(ctx) { /* ... */ },
    };
  },
};
```

### Built-in Plugin Normalization

Current built-in plugins export as factory functions returning `{ manifest, init, onRoomStart, ... }`. To unify the contract, the registry normalizes built-ins at registration time:

```js
// Normalization: convert built-in factory shape to canonical descriptor shape.
// The descriptor's `manifest` is the sole source of truth — plugin instances
// returned by `createPlugin()` do NOT carry manifest data.  This ensures
// `resolvePlugin()` always returns an authoritative { plugin, manifest } pair.
function normalizeBuiltin(factory) {
  // Call factory once to extract manifest (descriptor owns it from here on)
  const instance = factory();
  const manifest = instance.manifest;
  return {
    manifest,           // ← single source of truth for this plugin type
    createPlugin() {
      // Return a fresh instance each time — lifecycle hooks only, no manifest
      const p = factory();
      return {
        init: p.init,
        onRoomStart: p.onRoomStart,
        onTurnResult: p.onTurnResult,
        onFanOutComplete: p.onFanOutComplete,
        onEvent: p.onEvent,
        onResume: p.onResume,
        refreshPendingDecision: p.refreshPendingDecision,
        shutdown: p.shutdown,
      };
    },
  };
}
```

External plugins must export the canonical `{ manifest, createPlugin() }` shape directly. The registry does **not** normalize external exports — they must conform or fail validation. In either case, the **descriptor's `manifest`** is the single source of truth; callers access it via `resolvePlugin()` → `{ plugin, manifest }` or the registry query APIs (`getManifestByType()`, `getKnownTypes()`, `getAvailablePluginManifests()`).

### Plugin Discovery

**Canonical directory:** `~/.commands-agent/room-plugins/`

Override via environment variable: `COMMANDS_AGENT_ROOM_PLUGINS_DIR`

```
~/.commands-agent/room-plugins/
  my-plugin/
    manifest.json          ← required: validated before import
    index.js               ← required: plugin module
    package.json           ← optional: for npm dependency management
  another-plugin/
    manifest.json
    index.js
```

### Plugin Registry — Startup Preload + Synchronous Resolution

The registry uses a **two-phase approach**: async preload at startup (before any rooms can be created), then synchronous resolution during room creation. This avoids races and keeps `createRoom()` synchronous with respect to plugin lookup.

**`desktop/room/plugin-registry.js` changes:**

```js
// Built-in plugin factories (always available, normalized at init)
const BUILTIN_FACTORIES = {
  review_cycle: () => createReviewCyclePlugin(),
  war_room: () => createWarRoomPlugin(),
};

// Cached descriptors: Map<orchestratorType, { manifest, createPlugin }>
// Populated during preload, read synchronously thereafter.
const pluginDescriptors = new Map();

// Phase 1: Called once at app startup. Room IPC handlers are registered
// immediately (see Option A below), but gate registry-dependent operations
// on isRegistryReady() until this function completes.
export async function initPluginRegistry(pluginDir) {
  // 1a. Normalize and cache built-in plugins (synchronous)
  //     Note: validatePluginManifest() follows the existing codebase convention
  //     of returning { ok, error } rather than throwing. Callers must check
  //     result.ok and throw explicitly on failure.
  for (const [type, factory] of Object.entries(BUILTIN_FACTORIES)) {
    const descriptor = normalizeBuiltin(factory);
    const result = validatePluginManifest(descriptor.manifest);
    if (!result.ok) throw new Error(`Invalid manifest for ${type}: ${result.error.code}: ${result.error.message}`);
    pluginDescriptors.set(type, descriptor);
  }

  // 1b. Discover and load external plugins (async — dynamic imports)
  if (pluginDir) {
    await loadExternalPlugins(pluginDir);
  }

  // 1c. Mark registry as ready — only after ALL loading (built-in + external)
  //     is complete. This ensures isRegistryReady() does not report true
  //     while external plugins are still being scanned/imported.
  registryReady = true;
}

// Explicit readiness flag — set only after initPluginRegistry() fully completes
// (both built-in normalization AND external plugin scan/import).
// Using pluginDescriptors.size > 0 is insufficient because built-ins are
// inserted before the async external load completes, which would report
// ready too early.
let registryReady = false;

// Returns true when Phase 1 is complete and resolvePlugin() is safe to call.
export function isRegistryReady() {
  return registryReady;
}

async function loadExternalPlugins(pluginDir) {
  // 1. Scan pluginDir for subdirectories containing manifest.json + index.js.
  //    Sort subdirectory names lexicographically to ensure deterministic
  //    processing order across platforms (filesystem iteration order varies).
  // 2. For each candidate (in sorted order):
  //    a. Read manifest.json (plain JSON — no code execution)
  //    b. Validate manifest.json against strict JSON schema
  //       Required fields: id, name, version, orchestratorType, roles
  //       Optional fields: description, supportsQuorum, dashboard, limits,
  //         endpointConstraints, display, report
  //       Reject unknown top-level fields
  //    c. Run security verification (allowlist + optional integrity check)
  //    d. Check for orchestratorType collisions — reject if the manifest's
  //       orchestratorType is already registered (built-in or earlier external).
  //       Also reject duplicate id values as a secondary uniqueness constraint.
  //       orchestratorType is the primary key (used by resolvePlugin()), so its
  //       uniqueness is mandatory for correct runtime resolution.
  //       On collision, log both the rejected plugin's directory name and the
  //       previously registered plugin's identity.
  //       ↑ ALL of a–d happen BEFORE any import() — fail-closed.
  //       Since orchestratorType and id are available from manifest.json,
  //       collision rejection uses only pre-validated metadata and registry
  //       state. This prevents rejected plugins from executing top-level
  //       code during import.
  //    e. Dynamic import the plugin module (index.js)
  //    f. Validate export shape: must have { manifest, createPlugin }
  //    g. Deep-equal check: exported manifest must match manifest.json
  //       (prevents code from sneaking in different metadata)
  //    h. Cache in pluginDescriptors map (keyed by orchestratorType)
  //       ↑ Caching happens ONLY after post-import validation (f + g) succeeds.
  //       If any step e–g fails, roll back any temporary orchestratorType
  //       reservation from step d so the slot remains available.
  // 3. Errors in one plugin do not block others (log + skip)
}

// Phase 2: Synchronous — called during createRoom().
// Safe because all descriptors are pre-cached.
// Returns { plugin, manifest } so callers always have both without
// reaching into registry internals.
export function resolvePlugin(orchestratorType) {
  const descriptor = pluginDescriptors.get(orchestratorType);
  if (!descriptor) {
    throw new Error(`Unknown orchestratorType: ${orchestratorType}`);
  }
  return {
    plugin: descriptor.createPlugin(),
    manifest: descriptor.manifest,
  };
}

// ── Explicit Registry Query APIs ─────────────────────────────────
// These provide read-only access to registry data so that callers
// (validation, IPC, renderer) never depend on the internal
// pluginDescriptors Map.

// Returns the full descriptor { manifest, createPlugin } for a type.
// Use when you need both the manifest and the ability to instantiate.
export function resolvePluginDescriptor(orchestratorType) {
  const descriptor = pluginDescriptors.get(orchestratorType);
  if (!descriptor) {
    throw new Error(`Unknown orchestratorType: ${orchestratorType}`);
  }
  return descriptor;
}

// Returns an array of all registered orchestratorType strings.
export function getKnownTypes() {
  return Array.from(pluginDescriptors.keys());
}

// Returns the manifest for a single type (or undefined).
export function getManifestByType(orchestratorType) {
  return pluginDescriptors.get(orchestratorType)?.manifest;
}

// Returns serializable manifest data for all registered plugins.
// Used by IPC layer to send to renderer.
export function getAvailablePluginManifests() {
  return Array.from(pluginDescriptors.values()).map(d => d.manifest);
}
```

**Startup integration (main process):**

Current `desktop/main.js` registers IPC handlers at module top-level (synchronous), so `await initPluginRegistry(...)` cannot be inserted inline. Two options are available: register all IPC handlers immediately and gate registry-dependent operations with `isRegistryReady()` (Option A, preferred), or wrap all IPC registrations in an async bootstrap function that runs after `app.whenReady()` (Option B).

**Option A (minimal — preferred):** Keep existing IPC registrations synchronous. Register room IPC handlers immediately but gate registry-dependent operations on a readiness check. This avoids the race where renderer calls like `ROOM_STATUS` or `ROOM_PLUGIN_LIST` arrive before the plugin registry has finished loading, which would cause "No handler registered" errors if registration were deferred.

```js
// In desktop/main.js, alongside existing imports:
import { initPluginRegistry, isRegistryReady } from './room/plugin-registry.js';

// Resolve plugin directory (existing pattern from provider-registry wiring)
const roomPluginDir = process.env.COMMANDS_AGENT_ROOM_PLUGINS_DIR
  || path.join(os.homedir(), '.commands-agent', 'room-plugins');

// Start plugin preload immediately (runs in parallel with other sync init)
const pluginReady = initPluginRegistry(roomPluginDir);

// ... existing synchronous IPC registrations (agent, orchestration, profiles, etc.) ...

// Register room IPC handlers immediately — handlers that depend on the
// plugin registry check isRegistryReady() and return a structured error
// if called before preload completes. This prevents "No handler registered"
// errors from the renderer while still ensuring registry-dependent operations
// are safe.
roomIpc.register(ipcMain, { registry, roomRuntime });

// Await plugin readiness in the background — log but don't block app startup.
// Room IPC handlers will self-gate via isRegistryReady() until this resolves.
pluginReady.catch((err) => {
  console.error('Plugin registry init failed:', err);
});
```

Room IPC handlers that depend on plugin data (e.g., `ROOM_CREATE`, `ROOM_PLUGIN_LIST`) must check `isRegistryReady()` at the top of their handler and return a structured error if the registry is not yet available:

```js
// Example handler pattern with readiness gate:
registry.handle(ipcMain, CH.ROOM_PLUGIN_LIST, async (_event) => {
  if (!isRegistryReady()) {
    return { ok: false, error: { code: 'registry_not_ready', message: 'Plugin registry is still loading' } };
  }
  try {
    return { ok: true, manifests: getAvailablePluginManifests() };
  } catch (err) {
    return internalError(err.message);
  }
});
```

The `error` field uses an object shape `{ code, message }` rather than a bare string. This is compatible with the channel schema's `okResponse` / error contract — see the schema update below.

**Option B (full bootstrap refactor):** Wrap all IPC registrations in an async bootstrap function called from `app.whenReady()`. This is simpler — `initPluginRegistry()` completes before any handlers are registered, so no readiness gate is needed — but requires a larger refactor of `main.js`:

```js
async function bootstrap() {
  const roomPluginDir = process.env.COMMANDS_AGENT_ROOM_PLUGINS_DIR
    || path.join(os.homedir(), '.commands-agent', 'room-plugins');

  await initPluginRegistry(roomPluginDir);

  // Now register all IPC handlers (room handlers are safe to register —
  // registry is guaranteed ready)
  agentIpc.register(ipcMain, { ... });
  orchestrationIpc.register(ipcMain, { ... });
  roomIpc.register(ipcMain, { ... });
  // ...
}

app.whenReady().then(bootstrap);
```

Either option ensures `resolvePlugin()` is safe to call before any `ROOM_CREATE` handler fires. Option A is preferred for minimal diff; Option B is cleaner if `main.js` is already being refactored.

### IPC / Preload Wiring for Renderer

The renderer needs access to plugin manifests to build the room-create UI dynamically. Since `getAvailablePluginManifests()` lives in the main process, we add IPC channels to bridge this data.

**New IPC channel in `desktop/ipc/channel-manifest.js`:**

Add the channel constant to the `CH` object alongside the existing room channels:

```js
// In the CH object (Room orchestration section):
ROOM_PLUGIN_LIST: 'desktop:room:plugin-list',
```

Add the schema entry in the manifest object (Room domain section). The `output` schema declares the success shape (`ok: true` with `manifests`), and the `error` schema declares the failure shape (`ok: false` with `error: { code, message }`). The `error` field uses an object to carry both a machine-readable `code` (e.g., `'registry_not_ready'`) and a human-readable `message`:

```js
[CH.ROOM_PLUGIN_LIST]: inboundHandle({
  output: okResponse({
    manifests: { type: 'array' },
  }),
  error: okResponse({
    error: { type: 'object', required: ['code', 'message'], properties: {
      code: { type: 'string' },
      message: { type: 'string' },
    }},
  }),
}),
```

**Handler in `desktop/ipc/room-ipc.js`:**

Add inside the existing `register(ipcMain, deps)` function, following the same `registry.handle` + try/catch pattern used by the other `ROOM_*` handlers. Note: this handler **must** include `isRegistryReady()` gating since it depends on plugin data that may not yet be loaded (see Option A startup integration):

```js
import { getAvailablePluginManifests, isRegistryReady } from '../room/plugin-registry.js';

// Inside register(ipcMain, deps):
registry.handle(ipcMain, CH.ROOM_PLUGIN_LIST, async (_event) => {
  if (!isRegistryReady()) {
    return { ok: false, error: { code: 'registry_not_ready', message: 'Plugin registry is still loading' } };
  }
  try {
    return { ok: true, manifests: getAvailablePluginManifests() };
  } catch (err) {
    return internalError(err.message);
  }
});
```

**Preload bridge in `desktop/preload.cjs`:**

Add inside the existing `room: { ... }` namespace in `contextBridge.exposeInMainWorld('commandsDesktop', { ... })`:

```js
room: {
  // ... existing room methods ...
  pluginList: () => ipcRenderer.invoke('desktop:room:plugin-list'),
},
```

**Renderer usage:**

```js
// In room-create.js or state initialization
const { manifests } = await window.commandsDesktop.room.pluginList();
// manifests is an array of plugin manifest objects
// Use to build type selector, role options, validation rules, etc.
```

### Contracts Changes

**`desktop/lib/room-contracts.js`:**

- Remove hardcoded `SUPPORTED_ORCHESTRATOR_TYPES` array
- `validateRoomConfig()` signature changes to accept known types and manifest data:

```js
// Before:
export function validateRoomConfig(config)

// After:
export function validateRoomConfig(config, { knownTypes, manifests })
```

Where `knownTypes` is `getKnownTypes()` and `manifests` is `getAvailablePluginManifests()` (both exported from the registry).

- **Role validation** becomes manifest-driven: instead of hardcoded per-type branches (`war_room` → all workers; `review_cycle` → 1 implementer + N reviewers), the validator reads `manifest.roles` to check required/optional/forbidden/minCount.

- **Endpoint constraint validation**: checks `manifest.endpointConstraints` — e.g., if `requiresLocalParticipant` is true, at least one agent in the config must have a local endpoint. This prevents runtime failures after passing config validation.

- `ORCHESTRATOR_LIMITS` becomes a base/fallback set. External plugins declare their own limits in `manifest.limits`, which are merged at parse time.

- `parseLimits()` signature changes:

```js
// Before:
export function parseLimits(userLimits, participantCount, orchestratorType)

// After:
export function parseLimits(userLimits, participantCount, manifestLimits)
```

Where `manifestLimits` is the `manifest.limits` returned by `resolvePlugin()` (or `{}` for defaults).

**Important:** The `participantCount` argument must remain **role-aware** — current behavior computes different counts per orchestrator type (reviewers for `review_cycle`, workers for `war_room`) to establish the `maxTurns` floor. Rather than hardcoding type checks, the manifest should declare which role drives the floor calculation:

```json
"limits": {
  "turnFloorRole": "reviewer",
  "turnFloorFormula": "1 + N",
  ...
}
```

Where `turnFloorRole` identifies the role counted for the floor, and `turnFloorFormula` is one of `"1 + N"` (review_cycle default) or `"2 + N"` (war_room default). If omitted, the floor defaults to `1 + participantCount` using the first required role. The caller (`createRoom()`) filters `payload.agents` by `turnFloorRole` before passing the count to `parseLimits()`, preserving the existing per-orchestrator floor semantics without hardcoded type branches.

### Runtime Changes

**`desktop/room/room-runtime.js` — Updated `createRoom()` flow:**

The `createRoom()` function is updated to integrate plugin resolution and manifest-driven configuration in a defined order:

```js
async function createRoom(payload) {
  // 1. Resolve plugin — returns { plugin, manifest } so we have both
  //    without reaching into registry internals.
  const { plugin, manifest } = resolvePlugin(payload.orchestratorType);

  // 2. Get known types + manifests via public registry APIs
  const knownTypes = getKnownTypes();
  const manifests = getAvailablePluginManifests();

  // 3. Validate room config using manifest-driven rules
  //    (replaces hardcoded type checks with manifest.roles + endpointConstraints)
  validateRoomConfig(payload, { knownTypes, manifests });

  // 4. Parse limits using manifest.limits (replaces ORCHESTRATOR_LIMITS[type] lookup)
  //    participantCount must be role-aware to preserve turn-floor semantics:
  //    current behavior uses reviewer count for review_cycle and worker count
  //    for war_room. The manifest should declare which role(s) drive the floor
  //    via manifest.limits.turnFloorRole (defaults to first role in
  //    manifest.roles.required). This replaces hardcoded type checks.
  const floorRole = manifest.limits?.turnFloorRole ?? manifest.roles?.required?.[0];
  const participantCount = floorRole
    ? payload.agents.filter(a => a.role === floorRole).length
    : payload.agents.length;
  const limits = parseLimits(payload.limits, participantCount, manifest.limits ?? {});

  // 5. Parse quorum if manifest declares it (currently only war_room)
  //    Keyed off manifest flag, not hardcoded type check
  const quorum = manifest.supportsQuorum
    ? parseQuorum(payload.quorum)
    : undefined;

  // 6. Build room object, attach plugin + manifest
  const room = {
    plugin,
    manifest,       // manifest travels with the room for snapshot/UI
    limits,
    quorum,
    // ... rest of room state
  };

  // 7. Initialize plugin
  await Promise.resolve(plugin.init(ctx));

  return room;
}
```

Key changes from current flow:
- Plugin resolution happens **first** (step 1), before validation
- `resolvePlugin()` returns `{ plugin, manifest }` — the **descriptor's manifest** is the sole source of truth for all configuration; plugin instances do not carry manifest data
- `createRoom()` uses only the public registry APIs (`getKnownTypes()`, `getAvailablePluginManifests()`) — it never reads the internal `pluginDescriptors` Map
- `validateRoomConfig` receives registry data instead of checking a static list
- `parseLimits` receives `manifest.limits` instead of looking up `ORCHESTRATOR_LIMITS[type]`
- Quorum parsing is keyed off a manifest flag, not a hardcoded type check
- The room object stores `manifest` alongside `plugin` so snapshots/UI always have access

### UI Changes

#### `desktop/renderer/views/room-create.js`

- Type selector dropdown built dynamically from manifests fetched via `ROOM_PLUGIN_LIST` IPC
- Role options driven by `manifest.roles` (required/optional/forbidden)
- Default roster driven by `manifest.display.defaultRoster`
- Default add-role driven by `manifest.display.defaultAddRole`
- Validation rules driven by `manifest.roles.minCount` + `manifest.endpointConstraints`
- Display names auto-generated from role + index

```js
// Example: building role selector from manifest
function getRoleOptions(manifest) {
  const roles = [];
  if (manifest.roles.required) roles.push(...manifest.roles.required);
  if (manifest.roles.optional) roles.push(...manifest.roles.optional);
  // Filter out forbidden roles
  const forbidden = new Set(manifest.roles.forbidden ?? []);
  return roles.filter(r => !forbidden.has(r));
}
```

#### `desktop/renderer/views/room-list.js`

Currently has hardcoded `roomTypeLabel()` mapping (`war_room` → "War Room", `review_cycle` → "Review Cycle") and hardcoded cycle noun ("Execution" vs "Cycle").

**Changes:**
- `roomTypeLabel()` reads `manifest.display.typeLabel` from the room's snapshot (which includes the manifest), falling back to `manifest.name`, then to a humanized `orchestratorType`
- Cycle noun reads `manifest.display.cycleNoun`, defaulting to "Cycle"
- Room snapshots emitted via `OUT_ROOM_EVENT` must include the manifest (or at minimum `manifest.display`) so the renderer can render any type

```js
function roomTypeLabel(room) {
  return room.manifest?.display?.typeLabel
    ?? room.manifest?.name
    ?? humanize(room.orchestratorType)
    ?? 'Room';
}

function cycleNoun(room) {
  return room.manifest?.display?.cycleNoun ?? 'Cycle';
}
```

#### `desktop/renderer/views/room-dashboard.js`

Currently has hardcoded activity messages per type and hardcoded cycle noun.

**Changes:**
- Activity messages read from `manifest.display.activityMessages` with sensible defaults
- Cycle noun reads from `manifest.display.cycleNoun`
- Panel rendering remains data-driven from `manifest.dashboard.panels[]` (no change)

```js
function getActivityMessage(room, phase) {
  const msgs = room.manifest?.display?.activityMessages ?? {};
  const defaults = {
    idle: 'Waiting...',
    fanOut: 'Agents working...',
    singleTurn: 'Agent working...',
    synthesis: 'Processing...',
    planning: 'Planning...',
  };
  return msgs[phase] ?? defaults[phase] ?? '';
}
```

#### `desktop/renderer/views/room-report.js`

Currently has entirely separate rendering paths for `war_room` vs `review_cycle` (task board vs issue table).

**Changes:**
- Report title reads from `manifest.display.reportTitle`, defaulting to `manifest.name + " Report"`
- Summary section renders based on `manifest.report.summaryMetrics` — iterates metrics and renders appropriate counters
- Table section renders based on `manifest.report.table` — column definitions drive table headers and cell rendering
- Built-in report renderers for known metric types (`taskBoard`, `issueSummary`) remain as fallbacks
- External plugins that don't declare `manifest.report` get a generic report (turn log only)

```js
function renderReportTitle(room) {
  return room.manifest?.display?.reportTitle
    ?? `${room.manifest?.name ?? 'Room'} Report`;
}

function renderSummarySection(room) {
  const metricKeys = room.manifest?.report?.summaryMetrics ?? [];
  // For each metric key, look up room state and render counters
  // Falls back to built-in renderers for known keys (taskBoard, issueSummary)
}

function renderTable(room) {
  const tableDef = room.manifest?.report?.table;
  if (!tableDef) return ''; // No table for this plugin type
  const { metricKey, columns } = tableDef;
  // Render table headers from columns[].label
  // Render rows from room.state[metricKey] items, keyed by columns[].key
}
```

**`desktop/renderer/components/room-panels.js`:**

- Already data-driven from `manifest.dashboard.panels[]` — no changes needed
- New panel types from external plugins would need a renderer registry (see below)

### Custom Panel Renderers

External plugins may want custom panel types beyond the built-in set (counter-group, progress, phase, bar-chart, agent-status, table). Options:

1. **Restrict to built-in types.** Simplest. Plugins can only use the 6 existing panel types. Covers most use cases.
2. **HTML panel type.** Add a `html` panel type where the plugin provides a render function that returns an HTML string. Sandboxed via `srcdoc` iframe to prevent XSS.
3. **Renderer registry.** Plugins register custom renderers keyed by panel type. `renderPanel()` checks the registry before the built-in switch statement.

Recommendation: start with option 1, add option 3 later if needed.

### Security

External plugins run in the main Electron process (Node.js) and have full access to the system. This is a significant trust boundary. The loading pipeline must be **fail-closed**: any verification failure prevents the plugin from loading.

#### Pre-Import Verification Pipeline

Before a plugin's code is executed (i.e., before `import()`), the following checks must pass **in order**. Steps 1–4 operate exclusively on non-executable artifacts (`manifest.json`, allowlist, file hashes, registry state) — no plugin code runs until step 5.

1. **Allowlist check** — The plugin's directory name (or package name) must appear in an explicit allowlist file:
   ```
   ~/.commands-agent/room-plugins-allowed.json
   // Example:
   { "allowed": ["my-trusted-plugin", "@org/room-plugin-xyz"] }
   ```
   If the allowlist file does not exist, **no external plugins are loaded** (fail-closed).

2. **Manifest schema validation** — Read and validate the plugin's **`manifest.json`** file (plain JSON, no code execution) against a strict JSON schema. Required fields: `id`, `name`, `version`, `orchestratorType`, `roles`. Recognized optional top-level fields: `description`, `supportsQuorum`, `dashboard`, `limits`, `endpointConstraints`, `display`, `report`. Reject unknown top-level fields. **External plugins must provide `manifest.json`** — there is no fallback to inline/static-analysis of `index.js`. This guarantees that metadata validation never triggers code execution.

3. **Integrity verification** (recommended) — If the allowlist entry includes a `sha256` hash, compute the hash of the plugin directory contents and compare. Mismatch → reject.

   ```json
   {
     "allowed": [
       { "name": "my-plugin", "sha256": "abc123..." }
     ]
   }
   ```

4. **Collision check** — Using the pre-validated `manifest.json`, reject the plugin if `manifest.orchestratorType` is already registered in the descriptor cache (built-in or earlier external in lexicographic directory-name order). Also reject duplicate `manifest.id` values. On collision, log both the rejected plugin's directory name and the previously registered plugin's identity. This check uses only non-executable metadata plus registry state, so it must happen before import to avoid running top-level code in plugins that will be rejected. Note: this step may temporarily reserve the `orchestratorType` for race safety, but any reservation **must be rolled back** if the subsequent import or post-import validation (step 6) fails.

5. **Import** — Only after steps 1–4 pass, execute `await import(pluginPath)`.

6. **Post-import validation** — Validate the export shape (`{ manifest, createPlugin }`) and that `createPlugin` is a function. Additionally, perform a **deep-equal check** between the exported `manifest` object and the pre-validated `manifest.json` contents. If they differ, reject the plugin with a warning (prevents code from substituting different metadata post-import).

#### Dev-Only Bypass

For local development, a clearly-scoped bypass:

```bash
COMMANDS_AGENT_TRUST_ALL_PLUGINS=1  # Skips allowlist + integrity checks (steps 1 & 3)
```

**Exact precedence when `TRUST_ALL_PLUGINS` is set:**

1. **Allowlist membership check (step 1) — SKIPPED.** All plugin directories are treated as if they appear in the allowlist. The allowlist file is **not read at all** — it does not need to exist.
2. **Integrity verification (step 3) — SKIPPED.** Since the allowlist is not read, there are no `sha256` entries to check against. No hashes are computed or compared.
3. **All other checks — STILL ENFORCED.** Manifest schema validation (step 2), collision checks (step 4), import (step 5), and post-import validation (step 6) all run normally.

In summary, `TRUST_ALL_PLUGINS` disables steps 1 and 3 entirely (both depend on the allowlist file). It does **not** selectively read the allowlist for hashes while skipping membership — the allowlist file is completely bypassed.

This flag:
- Logs a prominent warning at startup: `⚠️ TRUST_ALL_PLUGINS is set — loading all external plugins without allowlist or integrity verification`
- Is **never** set in production builds / packaged app
- Only applies when `COMMANDS_AGENT_DEV=1` is also set (the existing `isDev && ...` check in `main.js`)

#### Runtime Isolation (API-Level Discipline Only)

> **Important:** External plugins run in the main Node.js/Electron process and are **not sandboxed**. A malicious plugin with full `require`/`import` access can bypass any API-level restrictions described below. The primary security control is the **fail-closed loading pipeline** (allowlist + integrity checks) which prevents untrusted plugins from loading at all. The measures below are **API-level discipline** to support well-intentioned plugins, not a security boundary against adversarial code.

- Plugin code interacts with its own room context via the `ctx` interface — the API surface only exposes the plugin's own room state
- The `ctx` object is frozen (`Object.freeze`) to prevent accidental prototype pollution from plugin bugs
- Plugin hook calls are wrapped in try/catch with timeouts (existing `pluginHookTimeoutMs`)
- These measures do **not** prevent a loaded plugin from accessing Node.js APIs, other rooms, IPC channels, or BrowserWindow references — they are convenience guardrails, not a sandbox

### Distribution

The discovery algorithm scans **direct subdirectories** of the plugin directory for `manifest.json` + `index.js`. It does **not** traverse `node_modules/` trees or resolve npm package entry points. This keeps discovery simple, deterministic, and free of npm resolution edge cases (scoped packages, hoisting, peer deps, etc.).

Supported installation methods:

- **Manual / local directory:** Copy the plugin directory into `~/.commands-agent/room-plugins/<plugin-name>/` (must contain `manifest.json` + `index.js`), then add to allowlist.

- **npm (with post-install copy):** If a plugin is published to npm, install it to a staging location and copy the plugin files into the plugins directory:
  ```bash
  # Install to a temp location, then copy the plugin into the discovery path
  npm pack @someone/room-plugin-xyz --pack-destination /tmp
  mkdir -p ~/.commands-agent/room-plugins/room-plugin-xyz
  tar -xzf /tmp/someone-room-plugin-xyz-*.tgz -C ~/.commands-agent/room-plugins/room-plugin-xyz --strip-components=1
  ```
  Then add `room-plugin-xyz` to the allowlist. Plugin authors should document their `files` field in `package.json` to ensure `manifest.json` and `index.js` are included in the tarball.

  > **Why not `npm install --prefix`?** — `npm install --prefix <dir>` places packages under `<dir>/node_modules/<pkg>/`, including scoped paths (`node_modules/@org/pkg/`). The discovery algorithm does not traverse `node_modules/` trees, so plugins installed this way would not be found. The `npm pack` + extract approach places files directly where discovery expects them.

- **Plugins with npm dependencies:** If a plugin itself depends on npm packages, it should include a `package.json` with its dependencies. After copying the plugin directory, run `npm install` within it:
  ```bash
  cd ~/.commands-agent/room-plugins/my-plugin && npm install
  ```
  The plugin's own `node_modules/` is fine — the discovery algorithm only looks for `manifest.json` + `index.js` at the top level of each subdirectory; it does not recurse into the plugin's `node_modules/`.

- **Future:** Built-in plugin marketplace / install command that automates download, placement, allowlist management, and integrity verification.

## Migration Path

### Phase 1: Normalize Plugin Contract

1. Update built-in plugins (`review-cycle-plugin.js`, `war-room-plugin.js`) to include `manifest.display`, `manifest.endpointConstraints`, and `manifest.report` fields
2. Add `normalizeBuiltin()` to `plugin-registry.js` — built-ins continue to export as factory functions but are normalized internally; descriptor `manifest` is the sole source of truth
3. External plugins must provide `manifest.json` + `index.js` exporting the canonical `{ manifest, createPlugin() }` shape

### Phase 2: Registry + Contracts

4. Implement `initPluginRegistry()` with async preload + cached descriptors
5. Expose public registry APIs: `resolvePlugin()` → `{ plugin, manifest }`, `resolvePluginDescriptor()`, `getKnownTypes()`, `getManifestByType()`, `getAvailablePluginManifests()`
6. Wire startup in `desktop/main.js` to call `initPluginRegistry(pluginDir)` — see "Startup integration" section above. Option A (preferred): register room IPC handlers immediately and gate registry-dependent handlers with `isRegistryReady()`, returning structured `registry_not_ready` errors until preload completes. Option B: full async bootstrap where `initPluginRegistry()` completes before any handlers are registered
7. Update `validateRoomConfig(config, { knownTypes, manifests })`:
   - Replace `SUPPORTED_ORCHESTRATOR_TYPES` check with `knownTypes.includes(config.orchestratorType)`
   - Replace hardcoded role branches with `manifest.roles` validation
   - Add `manifest.endpointConstraints` validation (e.g., `requiresLocalParticipant`)
8. Update `parseLimits(userLimits, participantCount, manifestLimits)`:
   - Accept `manifestLimits` object instead of looking up `ORCHESTRATOR_LIMITS[type]`
   - Merge manifest limits over base bounds
   - Read `turnFloorRole` and `turnFloorFormula` from manifest to compute role-aware `minTurns` floor (replaces hardcoded `orchestratorType === 'war_room'` branch)
9. Update `createRoom()` flow in `room-runtime.js`:
   - Destructure `{ plugin, manifest }` from `resolvePlugin()` — no direct access to registry internals
   - Pass manifest data to `validateRoomConfig` and `parseLimits` via public APIs
   - Store `manifest` on the room object for snapshot/UI access
   - Key quorum parsing off manifest flag, not hardcoded type

### Phase 3: IPC + Renderer

10. Add `ROOM_PLUGIN_LIST` IPC channel: `CH.ROOM_PLUGIN_LIST` in `channel-manifest.js` with schema, handler in `room-ipc.js`, preload bridge in `preload.cjs` under `room.pluginList()`
11. Include manifest (or `manifest.display`) in room snapshots sent via `OUT_ROOM_EVENT` — also add `manifest: { type: 'object' }` to the `OUT_ROOM_EVENT` payload schema in `channel-manifest.js`
12. Update `room-create.js`: dynamic type selector, manifest-driven roles/defaults/validation
13. Update `room-list.js`: manifest-driven `roomTypeLabel()` and `cycleNoun()`
14. Update `room-dashboard.js`: manifest-driven activity messages and cycle noun
15. Update `room-report.js`: manifest-driven report title, summary, and table rendering

### Phase 4: External Plugin Loading

16. Implement external plugin discovery — scan `pluginDir` subdirectories for `manifest.json` + `index.js` (does **not** traverse `node_modules/` trees). Plugin subdirectories are **sorted lexicographically by directory name** before processing to ensure deterministic load order across platforms.
17. Implement pre-import security pipeline:
    - Allowlist check (fail-closed if no allowlist file)
    - `manifest.json` schema validation (pure JSON, no code execution)
    - Optional integrity verification (SHA-256)
    - Collision rejection: reject plugins whose `manifest.orchestratorType` is already registered (built-in or earlier external in lexicographic order); reject duplicate `manifest.id` values. On collision, log both the rejected plugin's directory name and the previously registered plugin's identity. All collision checks use pre-validated manifest metadata only — they must complete before `import()`. Note: collision checks may temporarily reserve the `orchestratorType` to prevent races, but any reservation must be rolled back if subsequent import or post-import validation fails (step 18).
18. Post-import validation: export shape check + deep-equal between exported `manifest` and pre-validated `manifest.json`. **Only after post-import validation succeeds**, cache the accepted descriptor in `pluginDescriptors` keyed by `orchestratorType`. If post-import validation fails, remove any temporary reservation made during the collision check (step 17) so the slot remains available for other plugins.
19. Add `COMMANDS_AGENT_TRUST_ALL_PLUGINS` dev bypass
20. Document plugin authoring guide (including `npm pack` + extract distribution workflow)

Throughout: built-in plugins continue to work unchanged — they're just registered through the normalized path instead of a hardcoded map.
