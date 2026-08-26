# Design note: node-side module-identity split for dynamically loaded plugins on source-launched deployments

Status: analysis + applied local fix · 2026-08-26 · profile `vscode`
Affected deployment: this machine only (source-launched harness). npm-installed
deployments are believed unaffected. Companion record: [PROFILE-NOTES.md](PROFILE-NOTES.md),
section "2026-08-26".

## Summary

A third-party host plugin (`dsh-codex-provider`) that registers Typert remote
endpoints returns carrier-level 404 on every call under this deployment, even
though its Loader entry reports `active`. Root cause: the same
`@deepseek-ai/dsh-typert-protocol` package resolves to **two different physical
files** depending on where the importing file lives — TypeScript source for the
source-launched server, built `lib/` JavaScript for the out-of-repo plugin.
Typert's method-marker registry is module-private state, so the two instances
cannot see each other's registrations and the gateway never claims the plugin's
endpoints. Node grants one module instance per resolved file; nothing reunites
files that differ.

## Launch chain (why resolution is dual-track)

`start-vscode.cmd` runs the harness from repository source:

```
node --import tsx/esm apps/cli/src/bin.ts --profile vscode --port 3081   (cwd = repo root)
```

tsx discovers the repo root `tsconfig.json`, whose `paths` map rewrites bare
`@deepseek-ai/*` specifiers to workspace `packages/*/src`. Consequences by
importer location:

| importer | tsconfig paths apply? | protocol resolves to |
|---|---|---|
| any file inside the repo (first-party gateway, services) | yes | `packages/typert/protocol/src/index.ts` |
| the installed plugin (`~/.dsh/profiles/vscode/node_modules/dsh-codex-provider/lib/index.js`) | no — no tsconfig above `~/.dsh` | standard node_modules walk → profile junction → `exports` → `protocol/lib/index.js` |

Both files implement the same version of the package, but they are distinct
URLs, therefore distinct module records: separate class identities, separate
top-level state.

## Why the failure is total and silent

Typert's remote-method registration works by side effect: `Remote(name)`
schedules an initializer that records the method into a `WeakMap` keyed by the
class prototype, private to the importing module instance. The gateway's SRC
discovery reads markers through `remoteMethods(...)` exported from *its*
instance. With the instances split:

1. the plugin constructs fine, registers its Service under `codexProvider`,
   binds `typertRemote`, and writes six method markers — all into instance B;
2. the gateway scans `ctx.reflect.props`, finds the service, calls
   `remoteMethods(original)` through instance A, sees zero markers;
3. `claimsEndpoint('/codexProvider/loginStart')` returns false, no interceptor
   claims the path, and the connection layer answers `404`.

Nothing logs. The fiber is genuinely active; every layer did what its own
instance told it. A silent cross-instance identity break produces exactly the
"works in tests, dead in production" shape the repository's postmortem 0001
warns about, one level down: not a dropped export, but a dropped module share.

## Evidence

Diagnostic writes patched temporarily into the plugin confirmed each step:

```
module-eval        url=file:///.../profiles/vscode/node_modules/dsh-codex-provider/lib/index.js
constructor-enter
constructor-done   protocol=file:///C:/Users/non-admin/Documents/deepseek-harness/packages/typert/protocol/lib/index.js remoteMethods=6
```

The plugin saw its own six markers (instance B) while the gateway held
instance A. After the fix below, the same RPC returned
`HTTP 200 {"ok":true,"loggedIn":true,"providerConfigured":true,...}`.

## Fix applied locally

Both protocol imports in the installed
`node_modules/dsh-codex-provider/lib/index.js` were changed to the explicit
subpath export:

```js
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol/src/index.ts";
```

`./src/*` resolves through the same junction to the identical physical file the
server loads, so realpath dedupe reunifies the instance regardless of tsconfig
paths. The `.ts` extension is loadable because every import in this process
runs through tsx. Trade-off: the plugin now depends on the host loading source
(or at least being able to transpile `.ts`); acceptable for this profile,
documented in PROFILE-NOTES, and reverted-by-upgrade (see warning there).

## Alternatives considered

- **Rewrite the plugin onto first-party seams** (credentials provider +
  commands + custom loopback routes, the pi2dsh pattern): avoids typert
  entirely but replaces both halves of the plugin — larger change than the
  bug warrants here.
- **Teach the loader/gateway to scan markers through a well-known instance**
  (e.g. resolve the protocol once at boot and inject it): requires first-party
  changes; listed as the long-term recommendation instead.
- **Bundle the protocol into the plugin**: guarantees the split rather than
  fixing it — markers would live only in the bundled copy.

## Recommendations

For plugin authors (today): on deployments that launch from source, never rely
on bare-specifier imports of `@deepseek-ai/*` packages for identity-bearing
mechanisms (decorator registries, singletons, `instanceof`). Either pin the
shared file via an explicit subpath that exists in both src and built worlds,
or ride first-party seams that communicate through `ctx` state instead of
module state.

For dsh core (upstream proposal): the browser client solved this exact problem
with the platform module table — dynamic bundles request shared identity
instead of shipping copies. The node half of dynamically loaded plugins has no
equivalent. Options worth weighing: a node-side shared-module table consulted
by the Loader before falling back to normal resolution; or demoting typert's
marker WeakMap into a registry carried by the Cordis context
(`ctx.typert.remote.mark(...)`), which makes registration instance-safe by
construction and removes the private-state coupling altogether.

## Verification recipe (after any plugin update)

```powershell
$body = '{"type":"client-request","rpcId":"t","method":"codexProvider/status","payload":{"args":{}}}'
Invoke-WebRequest -Uri 'http://127.0.0.1:3081/api/codexProvider/status' -Method Post `
  -Body $body -ContentType 'application/json' -Headers @{Origin='http://127.0.0.1:3081'}
```

Expect `HTTP 200` with `"ok":true`. A 404 means the upgrade overwrote the
patch — reapply the import change above and restart the profile.
