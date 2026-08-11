# Hermes Token Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated Slate user generate one Hermes shared Token in the Web UI, persist it inside the existing `/data` volume, and copy it to Hermes without exposing Docker socket or Compose credentials.

**Architecture:** A `HermesTokenStore` owns the effective Agent Token. It loads `/data/hermes-agent-token` (derived from `dirname(BLOB_DIR)`) at startup, falls back to `HERMES_AGENT_TOKEN` when the file is absent, and atomically replaces the file when the authenticated Web endpoint receives a new token. The Hermes guard and status service read the same store. The frontend generates 32 random bytes with Web Crypto, posts the token once, keeps it only in React memory, and offers copy actions for the token and a ready-to-paste Hermes configuration.

**Tech Stack:** NestJS/Fastify + Bun + TypeScript, Node `fs/promises`, React 19, TanStack Query, Vite, Bun tests, Prettier/ESLint.

## Global Constraints

- Persist the token at `dirname(BLOB_DIR)/hermes-agent-token`; production `BLOB_DIR=/data/blobs` means `/data/hermes-agent-token`.
- Use 32 random bytes (64 lowercase hexadecimal characters) in the frontend.
- Accept only 32–256 ASCII characters matching `[A-Za-z0-9._~-]`.
- Write the file with mode `0600`, a random temporary sibling file, and atomic `rename`.
- The authenticated POST response is exactly `{ "configured": true }`; never return the Token.
- Preserve `HERMES_AGENT_TOKEN` as the startup fallback when the persistent file is absent.
- Do not mount Docker socket, Compose files, or add database migrations.
- Do not write the generated Token to `localStorage`, URLs, logs, or status responses.
- NAS rollout must modify only the Slate service and preserve MySQL, `/data`, network, port, and restart policy.

---

### Task 1: Add the persistent Token store contract and tests

**Files:**
- Create: `backend/src/modules/hermes/hermes-token.store.ts`
- Create: `backend/src/modules/hermes/hermes-token.store.test.ts`
- Modify: `backend/src/infra/config/app.config.ts`

**Interfaces:**
- Produces `HermesTokenStore.onModuleInit(): Promise<void>`, `HermesTokenStore.get(): string | undefined`, `HermesTokenStore.set(token: string): Promise<void>`, and exported `isValidHermesAgentToken(value: string): boolean`.
- `HermesTokenStore` receives `AppConfig.blobDir` and `AppConfig.hermesAgentToken`; it does not receive a Prisma client or Docker client.

- [ ] **Step 1: Add failing store tests**

Create a temporary directory for each test and use a minimal `AppConfig` stub. Cover:

```ts
it('falls back to the environment Token when the persistent file is absent', async () => {
  const store = new HermesTokenStore(config(tempDir, envToken));
  await store.onModuleInit();
  expect(store.get()).toBe(envToken);
});

it('writes a valid Token atomically with owner-only permissions and reloads it', async () => {
  const store = new HermesTokenStore(config(tempDir, undefined));
  await store.onModuleInit();
  await store.set(fileToken);
  expect(store.get()).toBe(fileToken);
  expect(await readFile(join(tempDir, 'hermes-agent-token'), 'utf8')).toBe(`${fileToken}\n`);
  expect((await stat(join(tempDir, 'hermes-agent-token'))).mode & 0o777).toBe(0o600);
});

it('rejects short, whitespace, and punctuation outside the allowlist', async () => {
  const store = new HermesTokenStore(config(tempDir, undefined));
  await expect(store.set('too-short')).rejects.toThrow();
  await expect(store.set(`${fileToken} `)).rejects.toThrow();
  expect(isValidHermesAgentToken(fileToken)).toBe(true);
});

it('fails closed when an existing persistent file is invalid', async () => {
  await writeFile(join(tempDir, 'hermes-agent-token'), 'bad-token\n');
  await expect(new HermesTokenStore(config(tempDir, envToken)).onModuleInit()).rejects.toThrow();
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run `bun test backend/src/modules/hermes/hermes-token.store.test.ts`. It must fail because the store and `AppConfig.hermesAgentTokenFile` do not exist yet.

- [ ] **Step 3: Add the AppConfig path and minimal store implementation**

Add `hermesAgentTokenFile` to `AppConfig` using `resolve(dirname(this.blobDir), 'hermes-agent-token')`. Implement startup loading, format validation, environment fallback, and atomic replacement:

```ts
const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
await writeFile(tmp, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
await chmod(tmp, 0o600);
await rename(tmp, this.path);
this.token = token;
```

Remove the temporary file on a failed write. Treat `ENOENT` as “no persistent Token”; rethrow all other read errors and invalid-file errors without including the Token or full path in the error message.

- [ ] **Step 4: Run the focused store tests**

Run `bun test backend/src/modules/hermes/hermes-token.store.test.ts`; all store tests must pass.

### Task 2: Wire the store into Agent auth, status, and the authenticated configuration API

**Files:**
- Modify: `backend/src/modules/hermes/hermes.module.ts`
- Modify: `backend/src/modules/hermes/hermes-agent-auth.guard.ts`
- Modify: `backend/src/modules/hermes/hermes-agent-auth.guard.test.ts`
- Modify: `backend/src/modules/hermes/hermes.controller.ts`
- Modify: `backend/src/modules/hermes/hermes.service.ts`
- Modify: `backend/src/modules/hermes/hermes.service.test.ts`

**Interfaces:**
- `HermesAgentAuthGuard` consumes `HermesTokenStore.get()` and `AppConfig.isProd`.
- `HermesService.configureAgentToken(token: string): Promise<void>` calls `HermesTokenStore.set(token)`.
- `HermesService.agentStatus(configured = this.tokenStore.get() !== undefined, now = Date.now())` retains the existing optional `configured` argument for pure unit tests.
- `POST /api/v1/hermes/token` consumes `{ token: string }` and produces `{ configured: true }`.

- [ ] **Step 1: Add failing auth/status/API tests**

Update the guard tests to inject a fake store (`{ get: () => token }`) and prove that a newly changed store value is the value compared by the guard. Update service tests to construct `HermesService` with a fake `HermesTokenStore`, and add a controller-level unit assertion that the configuration method returns only `{ configured: true }`.

- [ ] **Step 2: Run focused Hermes tests and verify the new expectations fail**

Run `bun test backend/src/modules/hermes/hermes-agent-auth.guard.test.ts backend/src/modules/hermes/hermes.service.test.ts`. The updated constructor/API expectations must fail before wiring is implemented.

- [ ] **Step 3: Register and wire `HermesTokenStore`**

Add `HermesTokenStore` to the Hermes module providers/exports. Inject it into `HermesAgentAuthGuard` and compare the request Bearer Token against `store.get()` with the existing timing-safe comparison. Keep non-production no-token behavior unchanged.

- [ ] **Step 4: Add the authenticated controller endpoint and dynamic status**

Add a Zod DTO with `z.string().regex(/^[A-Za-z0-9._~-]{32,256}$/)`, a non-public `@Post('token')` returning `{ configured: true }`, and change `GET /status` to call `hermes.agentStatus()` without reading the environment directly. Do not include the incoming Token in thrown error messages or response bodies.

- [ ] **Step 5: Run all backend Hermes tests**

Run `bun test backend/src/modules/hermes`; all existing and new tests must pass.

### Task 3: Add frontend generation, persistence, copy actions, and pure tests

**Files:**
- Create: `frontend/src/features/hermes/lib/hermes-token.ts`
- Create: `frontend/src/features/hermes/lib/hermes-token.test.ts`
- Modify: `frontend/src/features/hermes/query/hermes-queries.ts`
- Modify: `frontend/src/features/hermes/components/HermesConnectionSection.tsx`

**Interfaces:**
- `generateHermesAgentToken(): string` returns exactly 64 lowercase hexadecimal characters from `crypto.getRandomValues`.
- `buildHermesConfigTemplate(slateBackend: string, token?: string): string` emits placeholder values when `token` is absent and actual `HERMES_AGENT_TOKEN`/`SLATE_AGENT_TOKEN` values when present.
- `saveHermesAgentToken(token: string): Promise<{ configured: true }>` posts to `${API_PREFIX}/hermes/token`.

- [ ] **Step 1: Add failing pure helper tests**

Test the 64-character hex format, two successive values not being identical, and the placeholder/filled configuration template. Run `bun test frontend/src/features/hermes/lib/hermes-token.test.ts` and verify failure because the helper module is absent.

- [ ] **Step 2: Implement the pure helper module and query mutation**

Use `new Uint8Array(32)`, `crypto.getRandomValues(bytes)`, and a lowercase hex encoder. Add `saveHermesAgentToken` to the existing Hermes query module using the authenticated `api` client.

- [ ] **Step 3: Add the UI state and actions**

In `HermesConnectionSection`, keep `savedToken` and saving/error state in React memory only. The “生成并保存 Token” action generates a value, posts it, then exposes it for the current page only. On failure, clear the unsaved value and show the existing toast error. Add copy buttons for the full Token and the filled Hermes config; disable them until persistence succeeds. Refresh status after a successful save.

- [ ] **Step 4: Update setup copy and instructions**

Replace the manual `openssl rand -hex 32` step with “在上方生成并保存共享 Token”；explain that Slate Docker stores it in its existing `/data` volume and that the user only needs to paste the same value into Hermes Gateway. Keep the existing plugin installation and Gateway restart steps.

- [ ] **Step 5: Run frontend helper tests and production checks**

Run `bun test frontend/src/features/hermes/lib/hermes-token.test.ts`, `bun run --cwd frontend lint`, `bun run --cwd frontend typecheck`, and `bun run --cwd frontend build`.

### Task 4: Document the runtime behavior and perform repository-wide verification

**Files:**
- Modify: `frontend/README.md`
- Modify: `backend/README.md`
- Modify: `README.md`
- Keep: `docs/superpowers/specs/2026-08-11-hermes-token-generation-design.md`

- [ ] **Step 1: Document the one-time generation workflow**

Document the endpoint protection, `/data/hermes-agent-token` persistence, environment fallback, no-Token response rule, and the fact that replacing a Token requires updating/restarting Hermes Gateway.

- [ ] **Step 2: Run repository-wide checks**

Run `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun test backend`, and `bun run --cwd frontend build`. Fix only changes covered by this feature.

- [ ] **Step 3: Review the diff and commit the implementation**

Run `git diff --check`, inspect `git diff --stat` and the full diff for accidental secrets or Docker socket/Compose mounts, then commit with `feat(hermes): 前端生成并持久化共享 token`.

### Task 5: Publish and upgrade only Slate on the NAS

**Files/Systems:**
- GitHub Actions workflow `.github/workflows/docker.yml`
- NAS Compose `/vol1/1000/Docker/slate-ready/docker-compose.yml`
- NAS persistent data `/vol1/1000/Docker/slate-ready/data`

- [ ] **Step 1: Push the commit and wait for CI/Docker success**

Push `master`, wait for the Docker workflow, and verify the immutable `sha-<commit-short>` GHCR manifest contains `linux/amd64` and `linux/arm64`.

- [ ] **Step 2: Create an upgrade rollback anchor on the NAS**

Back up the Compose file and record the old Slate container ID/image digest, MySQL container ID, `/healthz`, port `18001`, `/data` mount, `slate-ready_default` network, and `unless-stopped` policy. Do not remove the old image or touch MySQL.

- [ ] **Step 3: Pull and recreate only `slate`**

Use the immutable mirror tag in the real project directory:

```bash
docker compose -f /vol1/1000/Docker/slate-ready/docker-compose.yml pull slate
docker compose -f /vol1/1000/Docker/slate-ready/docker-compose.yml up -d --no-deps --force-recreate slate
```

- [ ] **Step 4: Verify the runtime contract**

Read back the new revision/image ID, `HERMES_AGENT_TOKEN` compatibility, `/data` mount, network, port, restart policy, healthy Slate and unchanged healthy MySQL. Verify `/healthz` is 200, unauthenticated `/api/v1/hermes/token` is 401, and the response to an authenticated generation request is exactly `{configured:true}` without the Token.

- [ ] **Step 5: Verify persistence behavior on the live container**

Using a temporary authenticated Slate test account or the user’s existing account, generate a test Token, confirm the API response does not contain it, inspect only the file existence/permissions (never its content), verify a long-poll with the generated Token succeeds and an old Token fails, then keep the generated Token as the active user configuration. Do not print the Token in logs or reports.
