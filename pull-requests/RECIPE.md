# Pull requests

A side panel for Herdr that lists the pull requests of the repository you are working in, with their GitHub labels as colored chips, and a review panel to go through one PR without leaving Herdr. Filter the list by Open, Merged or All, and switch on "Mine" to see only your own. Click a row to open the PR in a review pane beside your terminal: conversation, review threads, changed files with diffs, the merge status and a GitHub-style green merge button. A ↗ on each row and a GitHub button in the pane still open the PR in the browser.

![Pull requests](preview.png)

## What you see

### The list (`pull-requests`)

- Header: "Pull requests", the repository (`owner/name`), and "N shown" (or "refreshing...").
- A filter row: **Open**, **Merged**, **All** on the left, **Mine** on the right (selected background when on).
- One row per PR (up to 50): `#number`, title (truncated), a status word (`draft`, `merged`, `closed`), a dim **↗** at the right end, then a dim line with author, branch, age (`5m`, `3h`, `2d`) and the review decision when set (`approved` in the working color, `changes requested` in the blocked color).
- Under that, one chip per label, tinted with the label's own GitHub color.
- The PR shown in the review pane has the `selected` background.
- Empty and error states: "No open pull requests.", "No open pull requests by you.", or the first line of the `gh` error (for example "no git remotes found").

### The review pane (`pr-review`)

Top to bottom, on the theme's `surface`:

- **Title row:** the PR title (14px semibold) followed by a dim `#number`; on the right a bordered **GitHub ↗** button, a **↻** refresh icon and a **✕** that closes the pane.
- **Facts row (11px, dim):** a state badge (Open in ansi green, Draft muted, Merged ansi magenta, Closed ansi red), the author, `head → base` in JetBrains Mono, `+additions` (ansi green), `−deletions` (ansi red), age. Then the label chips.
- **Merge box:** a rounded box on the theme `background` with one line per fact, each with a small round mark tinted with its color:
  - Review: ✓ "Changes approved" (green), ✕ "Changes requested" (red), • "Review required" (yellow).
  - Checks: ✓ "All checks have passed", ✕ "Some checks were not successful" or • "Some checks haven't completed yet", with counts ("2 failing, 3 successful, 11 skipped"). Click to unfold the list of checks (failing first, opened automatically when one fails); click a check to open its page.
  - Conflicts: ✓ "No conflicts with base branch", ✕ "This branch has conflicts", • "Checking for conflicts…".
  - Branch: "Branch is out-of-date", "Merging is blocked", "Some checks are failing", or "This pull request is still a draft".
  - Merged / closed PRs show a single line ("Merged into main" in magenta, "Closed" in red).
  - Bottom of the box: the action, and a one-line message (busy text, result in green, error in red).
- **Action:** a green split button (`#1f883d`, hover `#1a7f37`, white text, 30px high, 6px corners): the main part reads **Merge pull request**, **Squash and merge** or **Rebase and merge**; a 1px white-alpha divider; a 28px **⌄** part. Greyed when the branch has conflicts. A draft shows a grey **Ready for review** split button instead; a closed PR shows **Reopen pull request** and **Archive**.
- **Tabs:** Conversation, `Threads N open / total`, `Files N`, with an accent underline on the current one.
- **Conversation:** the description and every comment or review with a body as cards (author, verb, age, markdown body folded after 700 characters with Show more). Small events as one-liners: commits (consecutive ones folded into "pushed N commits", unfold for SHAs), label changes grouped per person ("alice added `bug` and removed `wip`", with chips), review requests, approvals, merged, closed, reopened, ready for review, converted to draft, force-pushed.
- **Threads:** one card per review thread, unresolved first: a status badge (Unresolved yellow, Resolved green, Outdated muted), `path:line`, the first author and `+N` replies. Unresolved ones are open with every comment; resolved ones are folded to a one-line preview.
- **Files:** one row per file: change letter (A green, D red, M yellow, R/C accent), the folder dim and the file name bright, `+N −N`. Click to unfold the diff (monospace 11px, `+` lines green on a faint green background, `-` lines red, `@@` lines accent; up to 400 lines per file).

### The merge menu (`pr-merge-menu`)

A 300px popup at the pointer, on `popover`:

- The methods the repo allows: "Create a merge commit", "Squash and merge", "Rebase and merge", each with a one-line hint and a ✓ on the current one.
- "Delete branch after merge" with a ✓ when on.
- A separator, then **Convert to draft** (muted icon), **Close pull request** (red text and icon), **Reopen pull request** for closed PRs, and **Archive pull request**.

## How it behaves

- The repository is the one of the focused terminal's folder (its git remotes). Switching space or focus switches the list.
- List data: `gh pr list --state <open|merged|all> --limit 50 [--author @me] --json number,title,author,labels,isDraft,updatedAt,url,reviewDecision,headRefName,state`. Changing a filter reloads at once; otherwise it checks every 4 seconds but only calls GitHub again after 25 seconds for the same folder and filters. "Mine" is not remembered across restarts.
- Clicking a row sets shared state `pr-review = { number, repo, cwd, url }`. If the shown tab has no `pr-review` pane, it runs `pane.split {direction: "right", mod: "pr-review", props: {}}`; otherwise it focuses that pane, which follows the new pick. The ↗ opens the URL with `cmd /c start` without opening the pane.
- The pane loads everything with one GraphQL query (`gh api graphql`): PR fields, labels, the last commit's `statusCheckRollup` with its check runs and status contexts, review threads with comments, files, and the timeline (comments, reviews, labeled/unlabeled, merged, closed, reopened, ready, draft, review requested, force-pushed, commits). Diffs come from REST (`repos/<repo>/pulls/<n>/files`) only when the Files tab needs them. It refreshes every 60 seconds and on ↻.
- Merge: clicking the green button asks inline ("Merge into main with a merge commit, then delete the branch?" with Cancel / Confirm merge). It merges with `PUT repos/<repo>/pulls/<n>/merge` and the chosen `merge_method`, then deletes the head branch with `DELETE repos/<repo>/git/refs/heads/<branch>` (skipped for forks or when the toggle is off; "already deleted" counts as success). The local checkout is never touched.
- Method: merge commit by default (`DEFAULT_METHOD` at the top of `pr-review/main.js`). Picking one in the menu saves it in shared `pr-review.method` for every PR; if a repo doesn't allow it, the first allowed one is used. The delete toggle is shared `pr-review.deleteBranch` (default on).
- Menu actions are written back as shared `pr-review.menu = { uid, action, at }`; the pane that opened the menu (matching `uid`) runs them. Convert to draft, Ready for review and Reopen run at once; Close and Archive ask inline first. Each is one GraphQL mutation on the PR id: `convertPullRequestToDraft`, `markPullRequestReadyForReview`, `closePullRequest`, `reopenPullRequest`, `archivePullRequest`.
- ✕ closes the pane (`pane.close`) and clears the list's pick. A pane opened with `props: { number, repo }` is pinned to that PR instead of following the list.
- Local machine only; on a remote machine the list says so.

## Built from

- Three mods, all `mod.json` `{ "place": "none" }` (the list also has `"title": "Pull requests"`, the pane `"title": "PR review"`):
  - `mods/pull-requests/`: `main.js`, `pr.svg`. Two roles: the default draws the list, `props: { "role": "toggle" }` draws a 130px tab-bar button that runs `layout.toggle {id: "pull-requests-panel"}`.
  - `mods/pr-review/`: `main.js`, `chevron.svg` (the split button's ⌄). A pane mod.
  - `mods/pr-merge-menu/`: `main.js` and four 16px `currentColor` stroke icons: `draft.svg`, `close.svg`, `reopen.svg`, `archive.svg`. Opened with `openOverlay({ mod: "pr-merge-menu", kind: "popup", width: 300, height, props: { uid, methods, method, deleteBranch, isDraft, state } })`.
- Simple integration (works with any layout you own; clone a shipped one first): wrap the `tabs` block in a row with
  `{ "id": "pull-requests-toggle", "type": "block", "content": { "mod": "pull-requests", "props": { "role": "toggle" } }, "size": { "px": 130 } }`
  and add to the row holding the panes
  `{ "id": "pull-requests-panel", "type": "column", "hidden": true, "children": [{ "id": "pull-requests", "type": "block", "content": { "mod": "pull-requests" } }], "size": { "px": 420 }, "min": 300, "max": 800 }`.
- Alternative: make `{ "id": "pull-requests", "type": "block", "content": { "mod": "pull-requests" } }` a child of the shared `panel-body` stack and add a button next to Files and Changes in a cloned copy of the `tabs` mod (its `panelButton("pull-requests", "Pull requests", "mods/pull-requests/pr.svg")`), selecting the stack child `pull-requests`.
- The review pane needs no layout entry: the list splits it in.
- Herdr APIs: `spaces`, `panes`, `focused`, `exec`, `theme`, `props`, `layout`, `run`, `shared`, `setShared`, `openOverlay`, `closeOverlay`; gpui-base `TextView.markdown` for comment bodies.
- Programs: the GitHub CLI `gh` (tried as `gh`, then `C:/Program Files/GitHub CLI/gh.exe`), logged in with `gh auth login`. Browser links use `cmd /c start` (Windows; use `open` / `xdg-open` elsewhere).

## Watch out

- `gh` must be installed and authenticated, and Herdr must see it on its PATH (restart Herdr after installing it). Merging, closing and archiving need write (archive: triage) access to the repo.
- It makes network calls to GitHub through `gh` only; nothing else leaves the machine. The merge button changes the real PR: it always asks first.
- Create each mod's `mod.json` before its `main.js`: Herdr docks a new mod folder into the shown layout the first time it sees it, and without `"place": "none"` the pane and menu end up as a 320px block in your layout.
- GitHub's timeline type is `UnlabeledEvent` (lowercase l). Grouping label events with a pattern like `(Un)?LabeledEvent` never matches removals and loops forever: the render is cut ("interrupted").
- Strip HTML comments (`<!-- -->`, used by PR templates) and `<picture>` / `<img>` tags before rendering markdown; folding a body in the middle of an open comment or code fence breaks the renderer. Close a cut code fence.
- Tabs and leading spaces in diffs collapse; replace them with non-breaking spaces.
- The menu popup has a fixed height: the pane computes it from the rows it will show (63px per method with a hint, 38px per plain row, 9px per separator). Keep hints to one line.
- Avoid regex literals with backslashes when generating files with shell tooling; they can be mangled.
- Hidden copies keep their timers, so the list and pane still poll (throttled) while not shown.

## Done when

- `herdr-app check` passes for `mods/pull-requests`, `mods/pr-review` and `mods/pr-merge-menu`, no layout file changed, and Herdr reports no errors.
- In a repo with PRs, the list shows titles, authors, ages and label chips with the right colors; Merged and All change the list; Mine keeps only your PRs.
- Clicking a PR opens one review pane to the right; clicking another PR updates the same pane; ✕ closes it.
- The pane shows the merge box with review, checks and conflicts; Conversation shows label additions and removals; Threads shows resolved and unresolved threads; Files unfolds a colored diff.
- The ⌄ opens the menu; picking Squash changes the button to "Squash and merge"; Close and Archive ask before acting.
- In a folder without a GitHub remote the list shows the `gh` error instead of a list.
