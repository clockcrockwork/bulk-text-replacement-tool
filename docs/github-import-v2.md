# GitHub import V2 specification

Status: proposed / implementation-ready  
Applies to: `main` only  
Tracking issue: #12

## 1. Scope

V2 adds GitHub as a **read-only input source**.

Supported flow:

`GitHubから追加 → repository → branch → pinned commit snapshot → directory/file picker → import`

This is a standalone feature of `bulk-text-replacement-tool`. It is not a `novel-ide` feature.

### In scope

- GitHub App authentication
- authorized repository selection
- branch selection
- directory/file checkbox tree
- recursive directory selection
- import of `.txt`, `.md`, and `.tex`
- GitHub provenance on imported inputs
- privacy/network contract for Vercel V2

### Out of scope

- commit / push
- branch creation
- pull request creation
- automatic sync
- overwrite of repository files
- GitHub as an output target

Write semantics remain deliberately undecided until the product defines how N inputs × M output groups map to Git.

## 2. GitHub App permissions

Use a GitHub App, not an OAuth App.

Effective permissions:

- Repository contents: **Read-only**
- Repository metadata: **Read-only**
- Account permissions: none
- Organization permissions: none
- Write permissions: none
- Webhooks: disabled

Metadata read is required to enumerate repositories available through the installation. Contents read covers branch, commit, tree, and blob reads.

## 3. Consent and authentication

When the user presses **GitHubから追加** while disconnected, show an app-level consent screen before navigating to GitHub.

Explain:

- the integration is read-only
- GitHub permission is granted per repository, not per individual file
- the user chooses which repositories the App can access on GitHub
- this app only fetches supported files selected in the picker
- commit / push / PR / automatic sync are not performed
- access credentials are not persisted
- reload or tab close requires reconnecting
- imported text is stored in the browser workspace like manually imported text

Authentication uses GitHub App web application flow with PKCE and `state`.

### Installation and authorization are separate

GitHub App installation and user authorization are different states. Do not treat a successful OAuth callback as proof that the App is installed on a repository, and do not trust an `installation_id` query parameter by itself.

V2 deliberately **does not enable “Request user authorization (OAuth) during installation”**. The application must launch the authorization URL itself so it can always supply its own `state`, `code_challenge`, `code_challenge_method=S256`, and exact `redirect_uri`.

Connection flow:

1. show the app-level consent screen
2. launch the explicit PKCE authorization flow
3. exchange the code and obtain an in-memory user access token
4. call `GET /user/installations`
5. if a usable installation exists, enumerate its repositories
6. if no usable installation exists, show **GitHub Appをインストール / 権限を設定**
7. after installation or repository-access changes, restart the explicit PKCE authorization flow and verify the installation through the API

A first-time user may therefore make one extra GitHub round trip. Prefer that over weakening PKCE or trusting an unverified installation identifier.

If the install/configuration page is opened separately while the application tab stays alive, the existing in-memory token may be rechecked after the user returns. This is an optimization, not a correctness requirement; the flow must also work by simply reconnecting.

### Temporary browser state

- generate `state` and PKCE verifier in the browser
- store only those values in `sessionStorage` while crossing the redirect
- after callback validation and token exchange, delete them immediately
- remove `code` and `state` from the address bar with `history.replaceState`

### Token exchange

A minimal Vercel Function performs only the OAuth token exchange.

It may receive:

- `code`
- `code_verifier`
- the selected callback identifier / `redirect_uri`

The Function must validate the request `Origin` against the app's explicit allowed origins and map/validate `redirect_uri` against an environment-specific exact allowlist. A browser-supplied arbitrary redirect URI must never be forwarded to GitHub.

It must not receive repository contents, manuscript text, rules, or converted output.

Requirements:

- GitHub App client secret exists only in Vercel environment variables
- callback URLs are registered as exact URLs; do not use wildcard callback matching
- token exchange accepts POST only and rejects origins / redirect URIs outside the configured allowlists
- use expiring GitHub App user access tokens
- return only the access token and expiry data needed by the browser
- if GitHub returns a refresh token, discard it server-side and do not return it
- send `Cache-Control: no-store`
- never log token, refresh token, code, verifier, or the raw token response
- do not send `X-GitHub-Api-Version` (see **REST API version and CORS** below); the OAuth token endpoint is not a versioned REST API endpoint

### Access token lifetime

The browser keeps the GitHub access token in React memory only.

Do not store it in:

- localStorage
- sessionStorage
- workspace state
- backup JSON

Reload, tab close, or expiry ends the GitHub connection. Reconnect instead of implementing refresh-token persistence in V2.

The in-app disconnect button is labelled **このタブの接続を解除**. It only discards the in-memory token and the cached listings of this tab. It does not revoke the user's authorization or uninstall the GitHub App on GitHub; the dialog says that access granted to the App is changed from the GitHub settings, so a local disconnect is not mistaken for a revocation.

## 4. Repository and branch selection

One picker session works with one repository and one branch.

Flow:

1. enumerate repositories available to the GitHub App installation
2. choose a repository
3. preselect its default branch
4. optionally choose a different branch
5. when the branch is selected, resolve its HEAD to a commit SHA
6. pin that commit SHA as the picker snapshot
7. use the same snapshot for tree browsing and blob reads

If the branch changes while the picker is open, do not silently move to the new HEAD.

Provide a **最新に更新** action that explicitly resolves and pins a new snapshot.

Selection belongs to the pinned snapshot. When a new snapshot is pinned (最新に更新 finds a new commit, or a branch is chosen), the selection is cleared and the status message says so. If 最新に更新 finds the same commit, nothing changes and the selection is kept.

Committing a single-file import (clicking a file name and adding/updating it) keeps the checkbox selection, so the user can check one file while building a multi-file selection. Committing a multi-file import clears the selection it used.

## 5. Tree picker

Use Git Trees API as the tree source.

Normal browsing:

- obtain the snapshot commit tree SHA
- load directories non-recursively
- lazy-load child trees when directories expand
- directory checkboxes are tri-state
- selecting an unopened directory selects its supported descendants conceptually
- when that directory is later expanded, children inherit the ancestor selection
- deselecting a descendant makes the parent indeterminate
- search/filter changes visibility only and must not change selection
- filter matching compares Unicode NFC forms (file names committed on macOS may be NFD); displayed names and paths are never rewritten
- selection rules are keyed by repository path in a `Map`, never as plain-object keys, so names such as `__proto__` behave like any other path
- while an enumeration or fetch is running, checkboxes are disabled; a result is accepted only if the selection is still the one it was computed from

Show:

- selected supported-file count
- known selected byte total
- source path
- branch and pinned commit identifier

Accessibility requirements:

- keyboard operable
- screen-reader state for checkbox / mixed state (native `indeterminate`, not `aria-checked` on a native checkbox)
- visible checkbox text is inside its `<label>`, so tapping the text toggles it and the accessible name matches the visible text
- usable on mobile and Safari

### Supported entries

Importable extensions are shared with the existing local import contract:

- `.txt`
- `.md`
- `.tex`

Exclude:

- directories themselves
- symlinks
- submodules
- unsupported extensions
- blobs over GitHub's supported maximum
- Git LFS pointer files when detected

Tree entry mode/type is authoritative for symlink and submodule exclusion.

## 6. Large repositories and API limits

Known GitHub constraints that affect the implementation:

- authenticated user access token: normally 5,000 requests/hour
- REST secondary limits apply; avoid high concurrency
- recursive Git tree can truncate at 100,000 entries or 7 MB
- Git blob endpoint supports blobs up to 100 MB
- repository and installation listings are paginated

Directory import may use recursive tree as a fast path only if `truncated === false`.

If a recursive response is truncated, fall back to non-recursive subtree traversal. Never treat a truncated tree as a complete successful selection.

Paginated listings (installations, repositories, branches) follow `Link: rel="next"` up to a safety cap. If the cap is reached while a next page still exists, the listing fails explicitly instead of returning a partial list, so "does not exist" is never confused with "not loaded".

Git trees are content-addressed: identical directories at different paths share a tree SHA. Any cache or staleness check for a directory listing must key on **tree SHA + directory path**, because listing entries carry repository paths that become provenance and source identity.

Blob fetch concurrency starts at 4 or fewer concurrent requests.

Respect rate-limit signals the browser can actually read: `x-ratelimit-remaining` / `x-ratelimit-reset` (exposed through CORS) and the error `message` in the response body. `retry-after` is **not** in GitHub's `Access-Control-Expose-Headers`, so browser code cannot read it; when a secondary rate limit is detected from the status and message, wait at least one minute as GitHub's rate-limit documentation advises. Do not retry continuously.

The error message shows when a rate limit is expected to lift (`x-ratelimit-reset`, or at least one minute for a secondary limit). Until that time **no request is sent to GitHub from any path**:

- The deadline is kept in the picker state, separate from the error message. Dismissing the error, changing the selection, closing and reopening, or reconnecting does not clear it.
- Every GitHub request goes through one entry point in the hook. Before the deadline, that entry point does not send the request; it shows the rate-limit message again instead.
- The buttons that would send requests are disabled until the deadline: **再試行**, **選択したファイルを確認**, and the plan step's fetch button. When the error message is gone, a status line still says why they are disabled.

A multi-file retry re-issues many requests, so the wait is enforced by behaviour, not only described.

`x-ratelimit-reset` is a time on GitHub's clock. It is turned into a wait on this device's clock and kept between one minute and one hour (the primary rate-limit window):

- If the device clock is behind, the reset looks far in the future. Without the upper bound the wait would grow, and beyond about 24.8 days the timer that re-enables the buttons would stop working.
- If the device clock is ahead, the reset may look already past. The lower bound keeps the minimum wait.

### REST API version and CORS

Repository data is fetched browser → `api.github.com` directly, so every request must pass GitHub's CORS policy. GitHub's CORS documentation shows the preflight response:

```text
Access-Control-Allow-Headers: Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, X-Requested-With
Access-Control-Expose-Headers: ETag, Link, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval
```

(https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests)

`X-GitHub-Api-Version` is not in `Access-Control-Allow-Headers`, so a browser request carrying it would be rejected at preflight. Therefore:

- browser requests send only `Accept` (CORS-safelisted) and `Authorization`
- the API version is **not pinned** from the browser; GitHub serves unversioned requests with its default version (currently `2022-11-28`, supported until 2028-03-10)
- the fields this feature reads (repository `id` / `name` / `owner.login` / `default_branch` / `private`, git ref / commit / tree / blob) are not affected by the `2026-03-10` breaking changes, so responses have the same shape under either version
- when GitHub announces the end of the default version, re-check the breaking changes of the version unversioned requests move to, and re-check whether the CORS policy allows `X-GitHub-Api-Version`
- the allowed / exposed header lists live in `src/lib/githubApi.ts`, and `e2e/githubCors.spec.ts` runs the app's headers and fetch options against a server that reproduces this policy in real browsers

## 7. Atomic import

GitHub import is a transaction from the workspace's point of view.

Before changing workspace state:

1. enumerate every selected supported path from the pinned snapshot
2. show the plan: the exact file list and file count, the byte total of entries whose size the tree reports, the number of entries whose size is unknown, and any large-selection warnings (§10); no blob has been fetched yet
3. fetch all required blobs only after the user confirms the plan
4. decode all blobs with the existing `decodeText`
5. validate all candidates
6. detect duplicate/source conflicts
7. show candidate summary
8. require final confirmation when a decision is needed
9. dispatch the workspace mutation only after all required candidates are ready

The plan step is always shown, even for a small selection. An unopened directory's contents are unknown until enumeration, so this is the first point where the real count and size can be shown, and fetching costs rate limit.

What the plan step guarantees: **no file content (blob) is fetched in bulk before the user has seen the exact target count**. Enumeration itself reads tree metadata from GitHub and does use API requests before the plan is shown. That cannot be avoided, because the count and paths are only known after enumeration. The number of requests cannot be predicted in advance either: a successful recursive tree takes one request per selected root, and a truncated one falls back to one or two requests per directory. The status message while enumerating says that file contents have not been fetched yet.

Neither list renders more than 100 rows at a time. There is no hard cap on the selection, so without this the screen that shows the warnings could itself become too large to render.

- The plan list shows the first 100 paths and a count of the rest. It only informs; nothing is decided there.
- The confirmation list is paged in steps of 100, with previous/next controls. Same-source candidates must be decided row by row, so every row has to stay reachable; a list that showed only the first 100 would leave the 101st undecidable. It shows candidates that need a decision first, then candidates with a warning (same basename, Shift_JIS guess), then the rest. The order does not change as choices are made, so the row being edited never moves away.
- Moving to another page scrolls the list back to its top (the pager sits below the list, so it is usually pressed after scrolling to the end) and moves focus to the range text (for example 「101〜120件目 / 全120件」), which is also a polite live region. The pressed button may become disabled at the first or last page, so focus must not stay on it.
- A bulk action (§9) removes its own button once nothing is left for it to decide, so focus moves to the step heading.
- The update-target `<select>` of one candidate lists at most the first 50 same-source inputs (plus the chosen one when it lies beyond them). Same-source inputs have no upper bound (**add as another input** can be repeated), so without this a single row could hold thousands of options. When there are more, the row also accepts the input's list number, so every target remains choosable.

The batch confirmation does not preview file contents. For Shift_JIS guesses it says so and points to going back and opening files one by one (the single-file view shows the text).

**選択へ戻る** on the plan step also cancels a fetch that is in progress. The remaining blob requests are aborted and the busy state is cleared.

Any fetch/decode/validation failure leaves the workspace unchanged.

Show failed paths and allow the user to retry or go back.

Use bounded concurrency and `AbortController` so cancellation stops pending work.

### Untouched sample workspace

If the workspace is still the untouched first-run sample (`isSample === true`), a GitHub import clears the sample inputs, groups, and rules in the same mutation that applies the imported inputs. An edited sample is the user's work and is never cleared automatically.

Whether the toast offers **元に戻す** depends on the import path:

- **Single-file import**: offers **元に戻す**, the same as the V1 local import. Undo restores the sample snapshot, which also drops the one imported file; that file is cheap to import again.
- **Multi-file import**: does **not** offer **元に戻す**. Undo restores the whole pre-import workspace, so it would also discard every imported file. Those files were fetched and validated over the network and cost rate limit to fetch again. The sample is only demo content, and a user who wants to study it can do so before importing. Losing the batch by accident is the heavier loss, so the batch path deliberately has no undo.

The toast still says that the sample was cleared, so the removal is never silent.

## 8. Input provenance

Extend `InputText` with optional GitHub provenance.

```ts
interface GitHubInputSource {
  kind: 'github';
  repositoryId: number;
  owner: string;
  repo: string;
  ref: string;
  commitSha: string;
  path: string;
  blobSha: string;
}

interface InputText {
  id: string;
  title: string;
  text: string;
  source?: GitHubInputSource;
}
```

The editable title remains the output filename source.

For GitHub imports:

- title defaults to basename
- full repository path is stored and displayed as provenance
- source identity is `repositoryId + ref + path`
- `commitSha` and `blobSha` are provenance, not identity

## 9. Duplicate rules

Local/manual import keeps the existing title-based behavior.

GitHub import uses source identity first.

### Same source identity already exists

Offer:

- update existing input
- add as another input
- cancel

If multiple existing inputs share the same source identity, never guess which one to update. Ask the user to select the target, add another, or cancel.

In a multi-file import, **cancel** means going back to the selection (**選択へ戻る**) and changing which files are checked. Choosing the files belongs to the tree picker. The confirmation step only decides add vs. update for candidates whose source already exists, and skipping a single candidate there is out of scope for Slice 2. It would need a second exclusion state beside the selection and would complicate the atomic batch.

Because a batch can contain many same-source candidates, the confirmation step offers two bulk actions that never guess:

- update every undecided candidate that has exactly one same-source input
- add every undecided candidate as a new input

Candidates with two or more same-source inputs still need an explicit choice, unless the user adds them all. Bulk actions never overwrite a choice that has already been made.

### Same basename but different GitHub source

Treat them as distinct inputs.

Do not show an overwrite prompt only because basenames match.

Candidate summary should warn about filename collisions and show full source paths.

The collision warning uses the same rules as the output file names (`outputFileName` and the case-insensitive key of `dedupeNames`), not raw title equality. `A.md` / `a.md`, or `a?.md` / `a*.md`, become the same output name and one of them gets ` (2)`, so they are warned about as well. Inputs of an untouched sample are left out of the comparison, because the same import clears them (§7 **Untouched sample workspace**).

Final output filename collision continues to use the existing output filename dedupe logic.

## 10. Persistence and backup

GitHub credentials are not part of workspace persistence.

GitHub provenance is.

### localStorage

Existing V1 workspace data has no `source`; normalize it as `source: undefined`.

The current workspace still stores full imported text in localStorage, so browser storage capacity is likely to become a practical constraint before GitHub's 100 MB blob limit.

V2 behavior:

- show selected file count and known bytes before fetch
- reject blobs over 100 MB before fetch
- warn for unusually large selections that browser persistence may fail
  - the plan step (§7) warns when the selection has more than 200 files (each blob is one more request against the usual 5,000 requests/hour; the warning counts only these blob requests, because the tree requests of the enumeration have already been spent when the plan is shown) or more than 2 MB in total (localStorage stops at a few MB)
  - it also warns whenever some entries have an unknown size. The shown total is then only a lower bound, and the real size cannot be checked before fetching, so this case is never shown as "no warning"
  - these are warnings only; there is no hard cap, so a legitimate large import is still possible after the user has seen the numbers. A hard safety ceiling may be added later, based on measurements of browser memory and storage failures on real devices; it is a separate layer from GitHub's 100 MB per-blob API limit
- keep the existing persistent save-failure warning and backup path
- do not make an IndexedDB migration a prerequisite for GitHub import

If storage capacity becomes a real blocker in production use, handle that as a separate issue.

### Backup format

Increase backup file format to version 2.

Requirements:

- V2 can import version 1 backups
- V2 writes version 2 backups
- version 2 preserves GitHub provenance
- frozen V1 may reject unknown version 2 backups instead of silently discarding provenance

## 11. Privacy and network contract

This specification intentionally changes the V2 network contract.

The frozen `release/lolipop-v1` branch keeps the V1 local-only behavior unchanged.

On `main` / Vercel V2:

- ordinary local/manual use does not contact GitHub
- GitHub content is fetched browser → GitHub directly
- repository content does not transit the Vercel backend
- manuscript text, rules, and converted output are never POSTed to the backend
- Vercel handles OAuth token exchange only
- GitHub connectivity exists only after explicit user action

CSP must be updated from the V1 `connect-src 'none'` contract to the minimum required allowlist, including:

```text
connect-src 'self' https://api.github.com
```

GitHub authorization/installation happens as top-level navigation. Repository content fetches are limited to `api.github.com`.

Privacy tests must continue using sentinels in manuscript/rule data and prove that they do not appear in outbound requests.

## 12. Failure states

Handle at least:

- authorization cancelled
- authorization succeeded but no usable App installation exists
- installation/configuration completed but repository access is still unavailable
- OAuth state mismatch
- token exchange failure
- token expired / 401
- App installation missing
- organization installation approval pending
- repository access revoked
- repository 404
- organization SAML SSO hides access
- empty repository
- no branches
- branch deleted
- snapshot resolution failure
- tree load failure
- recursive tree truncation
- selected file disappeared from the expected snapshot response
- rate limit
- network error
- unsupported file
- file over 100 MB
- Git LFS pointer detected
- decode failure
- Shift_JIS fallback
- partial blob failure
- same-source ambiguity

Rate-limit errors must be distinguishable from generic network failures.

## 13. Test requirements

### Unit

- tree normalization
- tri-state directory selection
- select parent before expansion, then child inherits selection
- deselect child → parent becomes mixed
- filter does not mutate selection
- extension filter
- symlink / submodule exclusion
- source identity
- duplicate resolution
- pinned snapshot handling
- tree truncation fallback
- partial failure leaves workspace unchanged
- storage migration with missing `source`
- backup v1 → v2 migration
- backup v2 round-trip

### E2E

Mock GitHub deterministically for normal automated tests.

Cover:

- disconnected state
- consent → explicit PKCE authorization start
- authorized but not installed → install/configure → reconnect
- repo → branch → pinned snapshot → tree → import
- directory recursive selection
- same-source update/add/cancel
- different-source same-basename import
- OAuth state mismatch
- callback query cleanup
- temporary PKCE/state cleanup
- access token not persisted
- refresh token not exposed to browser
- branch moves while picker is open; pinned snapshot still imports
- recursive tree truncation fallback
- 401/token expiry
- rate limit
- partial blob failure produces no workspace mutation
- local-only flow sends no GitHub/auth requests
- manuscript/rule sentinels never leave allowed boundaries
- GitHub-fetched content is not POSTed to the Vercel backend
- keyboard and mobile behavior

### Manual smoke test

Only on the Production deployment, or on a fixed verification origin that is registered in advance. The GitHub App callback and the token-exchange allowlist are exact origins, and the GitHub env variables are configured for Production only (`docs/github-app-setup.md`), so PR Preview deployments cannot complete real OAuth. The release order is: CI with mocked E2E → merge → Production deploy → this smoke test.

With a real GitHub App:

- install/authorize App
- choose an authorized repository
- choose a branch
- import at least one supported file
- confirm no write permission exists
- confirm reload requires reconnect
- confirm repository content does not appear in Vercel request logs

## 14. Acceptance criteria

- [ ] GitHub App has only Contents read-only + Metadata read-only repository permissions
- [ ] no account, organization, or write permission
- [ ] webhooks disabled
- [ ] explicit read-only consent before GitHub authorization
- [ ] installation and user authorization are handled as separate states
- [ ] “Request user authorization (OAuth) during installation” is disabled; V2 launches its own PKCE authorize URL
- [ ] token exchange validates allowed Origin and exact redirect URI instead of forwarding arbitrary browser input
- [ ] repository and branch picker works
- [ ] branch selection pins a commit SHA
- [ ] tree browsing and blob import use the same pinned SHA
- [ ] directory/file checkbox selection works, including unopened directory inheritance
- [ ] only supported files are importable
- [ ] recursive tree truncation cannot silently omit files
- [ ] import is atomic
- [ ] provenance is preserved
- [ ] same basename from different sources is not treated as the same source
- [ ] access token / refresh token / OAuth code are not persisted
- [ ] PKCE verifier / state are temporary and removed after callback
- [ ] refresh token is discarded server-side
- [ ] repository contents never transit the Vercel backend
- [ ] local/manual flow retains the existing privacy behavior
- [ ] backup v1 remains importable by V2; V2 writes backup v2
- [ ] browser requests to GitHub use only headers allowed by GitHub's documented CORS policy (no `X-GitHub-Api-Version`; default API version, see §6)
- [ ] rate limits, pagination, and truncation are handled
- [ ] `npm run check` passes
- [ ] GitHub import E2E passes
- [ ] real GitHub App OAuth smoke test passes on an exact callback URL (run on Production after merge; this is the release gate, see §13 **Manual smoke test**)
- [ ] `release/lolipop-v1` remains unchanged

## 15. Implementation status

### Slice 1 (single-file import)

Implemented:

- consent screen, explicit PKCE (S256) + `state` authorization, callback handling on app start
- token exchange Function `api/github/token.js` (Origin / exact redirect URI allowlists, refresh token discarded, `no-store`)
- in-memory access token; `sessionStorage` holds only `state` / verifier across the redirect
- installation check via `GET /user/installations`, install/configure link, and recheck
- repository list, default-branch preselection, branch change, pinned commit snapshot, explicit **最新に更新**
- minimal single-select file explorer: non-recursive Git Trees per directory, lazy loading, breadcrumb / up navigation, tap-first layout
- one supported blob fetched from the pinned snapshot, decoded with `decodeText`, Git LFS pointer rejection
- `InputText.source`, storage normalization, source-identity duplicate handling (update / add another / cancel, explicit target when ambiguous), provenance on input cards
- backup format version 2 (reads version 1)

Implementation decisions:

- callback URL is the origin root (`https://<origin>/`) because the build uses relative asset paths (`base: './'`)
- Client ID and App slug are build-time public values (`VITE_GITHUB_APP_CLIENT_ID`, `VITE_GITHUB_APP_SLUG`); without them the button is disabled. No runtime config endpoint. See `docs/github-app-setup.md`
- directory listings are cached and matched by repository id + tree SHA + path (identical subtrees share a SHA)
- pagination fails with an explicit error when the page cap is reached with pages remaining
- the Vercel Function is written in JavaScript with JSDoc types (TypeScript 7 has no JS transpile API for the Vercel builder to use)
- browser requests do not send `X-GitHub-Api-Version` because GitHub's documented CORS policy does not allow it (§6 **REST API version and CORS**); rate limits are classified from exposed `x-ratelimit-*` headers and the response `message`

### Slice 2 (multi-file import)

Implemented:

- directory/file checkbox picker with segment-aware include/exclude rules
- tri-state directories, unopened-directory inheritance, descendant exclusion, and explicit re-inclusion
- current-directory filter that changes visibility only and preserves selection
- known selected file/directory count and byte summary before enumeration
- a plan step after enumeration and before any blob fetch: exact file list and count, known-size byte total and unknown-size count, with warnings above 200 files or 2 MB and whenever a size is unknown
- plan list shows the first 100 rows plus a count; the confirmation list is paged by 100 (decision-needed and warned candidates first) so every candidate stays reachable
- 選択へ戻る during a fetch aborts the remaining blob requests and clears the busy state
- bulk same-source decisions (update single-target candidates / add all undecided) that never guess
- paging resets the list scroll and moves focus to the range text (a live region); bulk actions move focus to the heading
- a candidate's update-target list is bounded to 50 options, with selection by input number beyond that
- the filename collision warning follows the output-name rules and ignores an untouched sample
- a single-file import keeps the checkbox selection; a multi-file import clears it
- during a rate limit no request is sent to GitHub from any path (the deadline lives in state, is checked at the single request entry point, and disables 再試行 / 確認 / 取得); the reset time is kept between 1 minute and 1 hour on the device clock
- selection is locked while enumerating/fetching, and results computed from a different selection are discarded
- pinning a new snapshot clears the selection and says so
- recursive Git Trees fast path from the minimal selected roots
- truncated recursive responses are discarded and retraversed with complete non-recursive subtree reads
- final selected files are filtered by the selection rules and deduplicated by repository path
- blob fetching is bounded to at most 4 concurrent requests and cancellation propagates to sibling requests
- all blobs are fetched, decoded, and validated before the workspace is mutated
- a failed path leaves the workspace unchanged and is shown in the error
- batch same-source conflicts require an explicit update target; multiple matches are never guessed
- same-basename/different-source collisions are warnings only
- final batch application is one workspace reducer action, including untouched-sample cleanup (no undo; see §7 **Untouched sample workspace**)
- keyboard/mobile checkbox operation and screen-reader mixed state
- filter matching is Unicode-normalization aware (NFC)

The existing one-file preview/import path remains available alongside the checkbox flow. It continues to use the same pinned commit and provenance rules.
