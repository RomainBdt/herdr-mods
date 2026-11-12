// PR review pane: one pull request in a compact view (conversation with
// label changes, review threads and their status, changed files with diffs),
// its merge status, and a GitHub-style merge button whose ▾ menu
// (pr-merge-menu) picks the method and converts to draft, closes or archives.
// Opened by the pull-requests mod, which sets
// shared("pr-review") = { number, repo, cwd } and splits this pane in.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, theme, shared, setShared, props, panes, focused, run, openOverlay } from "herdr";

// Merge method: change DEFAULT_METHOD, or pick one in the merge button's ▾ menu
// (the choice is kept in shared "pr-review.method" for every PR).
const DEFAULT_METHOD = "MERGE"; // "MERGE" (merge commit) | "SQUASH" | "REBASE"
const METHOD_KEY = "pr-review.method";
const DELETE_KEY = "pr-review.deleteBranch"; // delete the head branch after merging (default true)
const METHODS = ["MERGE", "SQUASH", "REBASE"];
const METHOD_LABEL = { MERGE: "Merge pull request", SQUASH: "Squash and merge", REBASE: "Rebase and merge" };
const GREEN = "#1f883d", GREEN_HOVER = "#1a7f37", ON_GREEN = "#ffffff";

// Pull request mutations the ▾ menu and the closed-PR buttons run (GraphQL, by PR id).
const ACTIONS = {
  draft: { mutation: "convertPullRequestToDraft", busy: "Converting to draft…", done: "Converted to draft." },
  ready: { mutation: "markPullRequestReadyForReview", busy: "Marking ready…", done: "Ready for review." },
  close: { mutation: "closePullRequest", busy: "Closing…", done: "Pull request closed.", confirm: "Close this pull request?" },
  reopen: { mutation: "reopenPullRequest", busy: "Reopening…", done: "Pull request reopened." },
  archive: { mutation: "archivePullRequest", busy: "Archiving…", done: "Pull request archived.", confirm: "Archive this pull request? It will also be closed." },
};

const GH = ["gh", "C:/Program Files/GitHub CLI/gh.exe"];
const MONO = "JetBrains Mono";
const LONG = 700; // characters before a comment body folds
const DIFF_MAX = 400; // diff lines shown per file

const QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
 viewerDefaultMergeMethod mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
 pullRequest(number:$number){id number title url state isDraft body createdAt mergeable mergeStateStatus reviewDecision
  author{login} headRefName baseRefName additions deletions changedFiles isCrossRepository
  labels(first:20){nodes{name color}}
  commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{__typename
   ... on CheckRun{name status conclusion detailsUrl}
   ... on StatusContext{context state targetUrl}}}}}}}
  reviewThreads(first:100){nodes{isResolved isOutdated path line originalLine comments(first:50){nodes{author{login} body createdAt}}}}
  files(first:100){nodes{path additions deletions changeType}}
  timelineItems(first:250,itemTypes:[ISSUE_COMMENT,PULL_REQUEST_REVIEW,LABELED_EVENT,UNLABELED_EVENT,MERGED_EVENT,CLOSED_EVENT,REOPENED_EVENT,READY_FOR_REVIEW_EVENT,CONVERT_TO_DRAFT_EVENT,REVIEW_REQUESTED_EVENT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_COMMIT]){nodes{__typename
   ... on IssueComment{author{login} body createdAt}
   ... on PullRequestReview{author{login} body state createdAt}
   ... on LabeledEvent{actor{login} createdAt label{name color}}
   ... on UnlabeledEvent{actor{login} createdAt label{name color}}
   ... on MergedEvent{actor{login} createdAt}
   ... on ClosedEvent{actor{login} createdAt}
   ... on ReopenedEvent{actor{login} createdAt}
   ... on ReadyForReviewEvent{actor{login} createdAt}
   ... on ConvertToDraftEvent{actor{login} createdAt}
   ... on ReviewRequestedEvent{actor{login} createdAt requestedReviewer{... on User{login} ... on Team{name} ... on Bot{login}}}
   ... on HeadRefForcePushedEvent{actor{login} createdAt}
   ... on PullRequestCommit{commit{oid messageHeadline committedDate author{name user{login}}}}
  }}
 }}}`;

async function gh(args, cwd) {
  let last;
  for (const bin of GH) {
    try { return await exec(bin, args, { cwd: cwd || undefined, timeout: 60000 }); } catch (e) { last = e; }
  }
  throw new Error("GitHub CLI (gh) not found: " + String(last?.message || last));
}

function firstLine(r) {
  const text = (r.stderr || r.stdout || "gh failed").trim();
  try { const j = JSON.parse(r.stdout); if (j?.message) return j.message; } catch (_) {}
  return text.split("\n")[0];
}

function ago(iso) {
  if (!iso) return "";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  if (s < 86400 * 60) return Math.round(s / 86400) + "d";
  return Math.round(s / 86400 / 30) + "mo";
}

// Keeps diff indentation: tabs and leading spaces would otherwise collapse.
const indent = (l) => l.replace(/	/g, "    ").replace(/^([-+ ]?)( +)/, (_m, sign, sp) => sign + " ".repeat(sp.length));

const who = (a) => a?.login || a?.name || "ghost";

// One check, as GitHub groups it: "pass" | "fail" | "pending" | "skip".
function checkState(c) {
  if (c.__typename === "StatusContext")
    return { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail" }[c.state] || "pending";
  if (c.status !== "COMPLETED") return "pending";
  return { SUCCESS: "pass", NEUTRAL: "pass", SKIPPED: "skip", STALE: "skip" }[c.conclusion] || "fail";
}

export default class PrReview extends View {
  init(_p, cx) {
    this.uid = Math.random().toString(36).slice(2);
    this.key = null; this.pr = null; this.repoInfo = null; this.error = null; this.loading = false;
    this.tab = "conversation"; this.open = {}; this.patches = null; this.patchError = null;
    this.merge = "idle"; this.mergeMsg = null; this.confirm = null;
    this.menuAt = Date.now();
    this.watch(cx);
    cx.timer.every(300, (cx) => { this.watch(cx); this.menuPick(cx); });
    cx.timer.every(60000, (cx) => { if (this.pr && !this.loading && this.merge !== "running") this.load(cx); });
  }

  // Picks up what was chosen in this pane's ▾ menu (pr-merge-menu).
  menuPick(cx) {
    const m = shared("pr-review.menu");
    if (!m || m.uid !== this.uid || m.at <= this.menuAt) return;
    this.menuAt = m.at;
    const a = ACTIONS[m.action];
    if (!a || !this.pr) return;
    if (a.confirm) { this.confirm = m.action; this.mergeMsg = null; cx.notify(); }
    else this.runAction(m.action, cx);
  }

  openMenu() {
    const pr = this.pr, open = pr.state === "OPEN", mergeable = open && !pr.isDraft;
    // Row heights as drawn by pr-merge-menu: 63 with a hint line, 38 plain, 9 per separator.
    const rows = (mergeable ? this.methods().length * 63 + 38 + 9 + 38 : 0) + (open ? 38 : 0) + (pr.state === "CLOSED" ? 38 : 0) + 38;
    openOverlay({
      mod: "pr-merge-menu", kind: "popup", width: 300, height: rows + 16,
      props: { uid: this.uid, methods: this.methods(), method: this.method(), deleteBranch: this.deleteBranch(), isDraft: pr.isDraft, state: pr.state },
    });
  }

  deleteBranch() { return shared(DELETE_KEY) ?? true; }

  // Draft, ready, close, reopen, archive: one GraphQL mutation on the PR id.
  runAction(action, cx) {
    const a = ACTIONS[action], pr = this.pr, key = this.key, t = this.target();
    this.confirm = null; this.merge = "running"; this.mergeMsg = a.busy; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const q = `mutation($id:ID!){${a.mutation}(input:{pullRequestId:$id}){clientMutationId}}`;
        const r = await gh(["api", "graphql", "-f", `query=${q}`, "-f", `id=${pr.id}`], t?.cwd);
        let err = r.code !== 0 ? firstLine(r) : null;
        try { err = JSON.parse(r.stdout)?.errors?.[0]?.message || err; } catch (_) {}
        if (err) throw new Error(err);
        if (this.key !== key) return;
        this.merge = "done"; this.mergeMsg = a.done;
        this.load(cx);
      } catch (e) {
        if (this.key !== key) return;
        this.merge = "error"; this.mergeMsg = String(e?.message || e);
      } finally { cx.notify(); }
    });
  }

  // Closes this pane (and forgets the list's pick, unless the pane was pinned by props).
  closePane() {
    const p = props() || {};
    const pane = p.pane || panes().find((x) => x.mod === "pr-review" && x.tab === focused()?.tab)?.pane;
    if (!p.number) setShared("pr-review", null);
    if (pane) run("pane.close", { pane });
  }

  // props { number, repo } pins a PR; otherwise follow the list's pick.
  target() { const p = props(); return p?.number ? p : shared("pr-review") || null; }

  // Follows the PR picked in the list (shared state), reloading when it changes.
  watch(cx) {
    const t = this.target();
    const key = t ? `${t.repo || t.cwd}#${t.number}` : null;
    if (key === this.key) return;
    this.key = key; this.pr = null; this.error = null; this.open = {}; this.patches = null; this.patchError = null;
    this.merge = "idle"; this.mergeMsg = null; this.confirm = null; this.tab = "conversation";
    if (t) this.load(cx); else cx.notify();
  }

  load(cx) {
    const t = this.target();
    if (!t) return;
    const key = this.key;
    this.loading = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        let repo = t.repo;
        if (!repo) {
          const r = await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], t.cwd);
          if (r.code !== 0) throw new Error(firstLine(r));
          repo = r.stdout.trim();
        }
        const [owner, name] = repo.split("/");
        const r = await gh(["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${t.number}`, "-f", `query=${QUERY}`], t.cwd);
        if (this.key !== key) return;
        const j = JSON.parse(r.stdout || "{}");
        const pr = j?.data?.repository?.pullRequest;
        if (!pr) throw new Error(j?.errors?.[0]?.message || firstLine(r));
        this.repo = repo; this.repoInfo = j.data.repository; this.pr = pr; this.error = null;        if (this.patches) this.loadPatches(cx, true);
      } catch (e) {
        if (this.key === key) this.error = String(e?.message || e);
      } finally {
        if (this.key === key) this.loading = false;
        cx.notify();
      }
    });
  }

  // Diffs come from REST (GraphQL has no patches), only once the Files tab needs them.
  loadPatches(cx, force) {
    if (!this.pr || (this.patches && !force) || this.patchLoading) return;
    const key = this.key, t = this.target();
    this.patchLoading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await gh(["api", "--paginate", `repos/${this.repo}/pulls/${this.pr.number}/files?per_page=100`, "--jq", ".[] | {filename, patch}"], t?.cwd);
        if (this.key !== key) return;
        if (r.code !== 0) throw new Error(firstLine(r));
        const map = {};
        for (const line of r.stdout.split("\n")) {
          if (!line.trim()) continue;
          const f = JSON.parse(line);
          map[f.filename] = f.patch ?? null;
        }
        this.patches = map; this.patchError = null;
      } catch (e) { if (this.key === key) this.patchError = String(e?.message || e); }
      finally { this.patchLoading = false; cx.notify(); }
    });
  }

  // Methods this repo allows, in display order.
  methods() {
    const i = this.repoInfo || {};
    const allowed = { MERGE: i.mergeCommitAllowed, SQUASH: i.squashMergeAllowed, REBASE: i.rebaseMergeAllowed };
    const list = METHODS.filter((m) => allowed[m]);
    return list.length ? list : ["MERGE"];
  }

  // The preferred method (shared "pr-review.method", default merge commit),
  // or the first one the repo allows when it doesn't allow that one.
  method() {
    const list = this.methods(), pref = shared(METHOD_KEY) || DEFAULT_METHOD;
    return list.includes(pref) ? pref : list[0];
  }

  // Merges through the API, then (unless turned off in the ▾ menu) deletes the head
  // branch on GitHub. The local checkout is left alone (gh pr merge would switch
  // branches in this folder).
  doMerge(cx) {
    const pr = this.pr, repo = this.repo, key = this.key, t = this.target(), del = this.deleteBranch();
    this.confirm = null; this.merge = "running"; this.mergeMsg = "Merging…"; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const m = await gh(["api", "-X", "PUT", `repos/${repo}/pulls/${pr.number}/merge`, "-f", `merge_method=${this.method().toLowerCase()}`], t?.cwd);
        if (m.code !== 0) throw new Error(firstLine(m));
        let note = "Merged.";
        if (!del) note = "Merged, branch kept.";
        else if (!pr.isCrossRepository) {
          const d = await gh(["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${encodeURIComponent(pr.headRefName)}`], t?.cwd);
          // 422: already deleted (repo deletes branches on merge).
          note = d.code === 0 || /Reference does not exist|422/.test(d.stdout + d.stderr) ? "Merged, branch deleted." : "Merged; branch not deleted: " + firstLine(d);
        } else note = "Merged (branch is on a fork, not deleted).";
        if (this.key !== key) return;
        this.merge = "done"; this.mergeMsg = note;
        this.load(cx);
      } catch (e) {
        if (this.key !== key) return;
        this.merge = "error"; this.mergeMsg = String(e?.message || e);
      } finally { cx.notify(); }
    });
  }

  openUrl(url) { exec("cmd", ["/c", "start", "", url]).catch(() => null); }

  // ---- pieces -------------------------------------------------------------

  btn(id, label, opts, onClick) {
    const t = theme();
    const bg = opts.primary ? t.solid : opts.danger ? t.blocked : t.raised;
    const fg = opts.primary ? t.solid_foreground : opts.danger ? t.background : t.foreground;
    return h_flex().id(id).h(26).px(10).items_center().gap(6).rounded(6).text_size(12).flex_none()
      .bg(bg).text_color(fg).border(1).border_color(opts.primary || opts.danger ? bg : t.border)
      .when(opts.disabled, (e) => e.opacity(0.45))
      .when(!opts.disabled, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)).on_click(onClick))
      .child(label);
  }

  badge(text, color) {
    return div().px(6).rounded(4).text_size(11).flex_none().text_color(color).border(1).border_color(color + "88").child(text);
  }

  chip(label) {
    const t = theme(), c = "#" + (label.color || "888888");
    return div().px(6).rounded(4).text_size(11).flex_none().text_color(t.foreground).bg(c + "44").border(1).border_color(c).child(label.name);
  }

  body(id, text) {
    const t = theme();
    // GitHub hides HTML comments (PR templates); pictures/images from bots don't render here.
    text = (text || "").replace(/\r\n/g, "\n")
      .replace(/<!--[\s\S]*?(-->|$)/g, "")
      .replace(/<picture>[\s\S]*?<\/picture>/gi, "")
      .replace(/<\/?(img|source)\b[^>]*>/gi, "")
      .replace(/\n{3,}/g, "\n\n").trim();
    if (!text) return div().text_size(12).text_color(t.dim).child("No description.");
    const long = text.length > LONG, open = this.open[id];
    let shown = text;
    if (long && !open) {
      shown = text.slice(0, LONG).replace(/\s+\S*$/, "").replace(/<[^>]*$/, "");
      if ((shown.match(/^\s*```/gm) || []).length % 2) shown += "\n```"; // close a cut code block
      shown += "\n\n…";
    }
    return v_flex().gap(2).text_size(12)
      .child(TextView.markdown("md-" + id + (open ? "-o" : ""), shown).selectable(true))
      .when(long, (e) => e.child(div().id("more-" + id).text_size(11).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.open[id] = !open; cx.notify(); })
        .child(open ? "Show less" : "Show more")));
  }

  header() {
    const t = theme(), pr = this.pr;
    const state = pr.state === "MERGED" ? ["Merged", t.ansi5] : pr.state === "CLOSED" ? ["Closed", t.ansi1] : pr.isDraft ? ["Draft", t.muted] : ["Open", t.ansi2];
    const icon = (id, label, onClick) => div().id(id).w(26).h(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_size(14).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick).child(label);
    return v_flex().px(12).pt(10).pb(10).gap(6).border_b(1).border_color(t.border)
      .child(h_flex().gap(4).items_start()
        .child(div().flex_1().min_w(0).pr(4).text_size(14).font_semibold()
          .child(pr.title + "  ").child(div().text_color(t.dim).font_weight(400).child("#" + pr.number)))
        .child(this.btn("pr-gh", "GitHub ↗", {}, () => this.openUrl(pr.url)))
        .child(icon("pr-refresh", this.loading ? "…" : "↻", (_e, cx) => { this.load(cx); if (this.patches) this.loadPatches(cx, true); }))
        .child(icon("pr-close-pane", "✕", () => this.closePane())))
      .child(h_flex().gap(6).items_center().flex_wrap().text_size(11).text_color(t.dim)
        .child(this.badge(state[0], state[1]))
        .child(div().child(who(pr.author)))
        .child(div().font_family(MONO).child(`${pr.headRefName} → ${pr.baseRefName}`))
        .child(div().text_color(t.ansi2).child("+" + pr.additions))
        .child(div().text_color(t.ansi1).child("−" + pr.deletions))
        .child(div().child(ago(pr.createdAt))))
      .when(pr.labels?.nodes?.length, (e) => e.child(h_flex().gap(4).flex_wrap().children(pr.labels.nodes.map((l) => this.chip(l)))))
      .child(this.mergeBox());
  }

  // One line of the merge box: a status mark, what it is, and a detail.
  statusRow(id, mark, color, title, detail, onClick, open) {
    const t = theme();
    return h_flex().id(id).gap(8).px(10).py(5).items_center().text_size(12)
      .when(onClick, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
      .child(div().w(16).h(16).flex_none().flex().items_center().justify_center().rounded_full()
        .bg(color + "26").text_size(10).text_color(color).child(mark))
      .child(div().flex_none().text_color(t.foreground).child(title))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(detail || ""))
      .when(onClick, (e) => e.child(div().text_size(11).text_color(t.dim).child(open ? "▾" : "▸")));
  }

  // GitHub's merge box: review, checks, conflicts, branch state, then the merge button.
  mergeBox() {
    const t = theme(), pr = this.pr, rows = [];
    const ok = t.ansi2, bad = t.ansi1, wait = t.ansi3;
    if (pr.state === "MERGED") rows.push(this.statusRow("st-merged", "⇄", t.ansi5, "Merged", `into ${pr.baseRefName}`));
    else if (pr.state === "CLOSED") rows.push(this.statusRow("st-closed", "✕", bad, "Closed", "Not merged"));
    else {
      const review = {
        APPROVED: ["✓", ok, "Changes approved"],
        CHANGES_REQUESTED: ["✕", bad, "Changes requested"],
        REVIEW_REQUIRED: ["•", wait, "Review required", "At least one approving review is required"],
      }[pr.reviewDecision];
      if (review) rows.push(this.statusRow("st-review", review[0], review[1], review[2], review[3]));

      const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes || [];
      if (contexts.length) {
        const n = { pass: 0, fail: 0, pending: 0, skip: 0 };
        for (const c of contexts) n[checkState(c)]++;
        const [mark, color, title] = n.fail ? ["✕", bad, "Some checks were not successful"] : n.pending ? ["•", wait, "Some checks haven't completed yet"] : ["✓", ok, "All checks have passed"];
        const detail = [n.fail && `${n.fail} failing`, n.pending && `${n.pending} pending`, n.pass && `${n.pass} successful`, n.skip && `${n.skip} skipped`].filter(Boolean).join(", ");
        const open = this.open["checks"] ?? n.fail > 0;
        rows.push(this.statusRow("st-checks", mark, color, title, detail, (_e, cx) => { this.open["checks"] = !open; cx.notify(); }, open));
        if (open) {
          const order = { fail: 0, pending: 1, pass: 2, skip: 3 };
          const sorted = [...contexts].sort((a, b) => order[checkState(a)] - order[checkState(b)]);
          rows.push(v_flex().pl(34).pr(10).pb(4).children(sorted.map((c, i) => {
            const s = checkState(c), url = c.detailsUrl || c.targetUrl;
            const m = { pass: ["✓", ok], fail: ["✕", bad], pending: ["•", wait], skip: ["–", t.dim] }[s];
            return h_flex().id("chk-" + i).gap(8).py(2).items_center().text_size(11)
              .when(url, (e) => e.cursor_pointer().hover((st) => st.text_color(t.foreground)).on_click(() => this.openUrl(url)))
              .child(div().w(12).flex_none().text_color(m[1]).child(m[0]))
              .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(c.name || c.context))
              .when(url, (e) => e.child(div().text_color(t.dim).child("↗")));
          })));
        }
      }

      const conflict = {
        MERGEABLE: ["✓", ok, "No conflicts with base branch"],
        CONFLICTING: ["✕", bad, "This branch has conflicts", "Resolve them before merging"],
        UNKNOWN: ["•", wait, "Checking for conflicts…"],
      }[pr.mergeable];
      if (conflict) rows.push(this.statusRow("st-conflict", conflict[0], conflict[1], conflict[2], conflict[3]));

      const branch = {
        BEHIND: ["•", wait, "Branch is out-of-date", `Behind ${pr.baseRefName}`],
        BLOCKED: ["✕", bad, "Merging is blocked", "Branch rules aren't satisfied"],
        UNSTABLE: ["•", wait, "Some checks are failing", "Merging is still allowed"],
        DRAFT: ["•", t.muted, "This pull request is still a draft", "Mark it ready for review to merge"],
      }[pr.isDraft ? "DRAFT" : pr.mergeStateStatus];
      if (branch) rows.push(this.statusRow("st-branch", branch[0], branch[1], branch[2], branch[3]));
    }

    return v_flex().mt(2).rounded(6).border(1).border_color(t.border).bg(t.background)
      .child(v_flex().py(3).children(rows))
      .child(h_flex().gap(8).px(10).py(8).items_center().flex_wrap().border_t(1).border_color(t.border)
        .child(this.actions())
        .child(div().flex_1().min_w(0).truncate().text_size(11)
          .text_color(this.merge === "error" ? t.ansi1 : this.merge === "done" ? t.ansi2 : t.dim)
          .child(this.mergeMsg || "")));
  }

  // The split merge button (▾ opens pr-merge-menu), or a confirmation, or buttons for a closed PR.
  actions() {
    const t = theme(), pr = this.pr, busy = this.merge === "running";
    const method = this.method();
    if (this.confirm) {
      const merge = this.confirm === "merge";
      const how = { MERGE: "with a merge commit", SQUASH: "squashed", REBASE: "rebased" }[method];
      const text = merge ? `Merge into ${pr.baseRefName} ${how}${this.deleteBranch() ? ", then delete the branch" : ""}?` : ACTIONS[this.confirm].confirm;
      const yes = merge ? "Confirm merge" : this.confirm === "close" ? "Close pull request" : "Archive";
      return h_flex().gap(6).items_center().flex_wrap()
        .child(div().text_size(12).text_color(t.foreground).child(text))
        .child(this.btn("pr-no", "Cancel", {}, (_e, cx) => { this.confirm = null; cx.notify(); }))
        .child(merge ? this.green("pr-yes", yes, false, (_e, cx) => this.doMerge(cx))
          : this.btn("pr-yes", yes, { danger: true }, (_e, cx) => this.runAction(this.confirm, cx)));
    }
    if (pr.state === "MERGED") return div();
    if (pr.state === "CLOSED")
      return h_flex().gap(6)
        .child(this.btn("pr-reopen", "Reopen pull request", { disabled: busy }, (_e, cx) => this.runAction("reopen", cx)))
        .child(this.btn("pr-archive", "Archive", { disabled: busy }, (_e, cx) => { this.confirm = "archive"; this.mergeMsg = null; cx.notify(); }));

    const more = div().id("pr-merge-more").w(28).h_full().flex().items_center().justify_center()
      .cursor_pointer().hover((s) => s.bg(pr.isDraft ? t.hover : GREEN_HOVER))
      .on_click(() => this.openMenu())
      .child(svg("mods/pr-review/chevron.svg").size(14).text_color(pr.isDraft ? t.foreground : ON_GREEN));
    if (pr.isDraft)
      return h_flex().h(30).rounded(6).border(1).border_color(t.border).bg(t.raised).text_color(t.foreground)
        .child(div().id("pr-ready").px(12).h_full().flex().items_center().text_size(13).font_semibold()
          .when(!busy, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.runAction("ready", cx)))
          .child("Ready for review"))
        .child(div().w(1).h_full().bg(t.border))
        .child(more);
    const disabled = busy || pr.mergeable === "CONFLICTING";
    return h_flex().h(30).rounded(6).bg(GREEN).text_color(ON_GREEN).overflow_hidden()
      .child(div().id("pr-merge").px(12).h_full().flex().items_center().text_size(13).font_semibold()
        .when(disabled, (e) => e.opacity(0.55))
        .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(GREEN_HOVER))
          .on_click((_e, cx) => { this.confirm = "merge"; this.mergeMsg = null; cx.notify(); }))
        .child(busy ? "Working…" : METHOD_LABEL[method]))
      .child(div().w(1).h_full().bg("#ffffff40"))
      .child(more);
  }

  // A plain green button (the merge confirmation).
  green(id, label, disabled, onClick) {
    return h_flex().id(id).h(26).px(12).items_center().rounded(6).text_size(12).font_semibold().flex_none()
      .bg(GREEN).text_color(ON_GREEN)
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(GREEN_HOVER)).on_click(onClick))
      .child(label);
  }

  tabs() {
    const t = theme(), pr = this.pr;
    const threads = pr.reviewThreads.nodes, unresolved = threads.filter((x) => !x.isResolved).length;
    const items = [
      ["conversation", "Conversation"],
      ["threads", `Threads ${unresolved ? unresolved + " open / " : ""}${threads.length}`],
      ["files", `Files ${pr.changedFiles}`],
    ];
    return h_flex().px(8).gap(2).border_b(1).border_color(t.border).children(items.map(([id, label]) => {
      const on = this.tab === id;
      return div().id("tab-" + id).px(10).py(6).text_size(12).cursor_pointer()
        .text_color(on ? t.foreground : t.muted).border_b(2).border_color(on ? t.accent : "#00000000")
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.tab = id; if (id === "files") this.loadPatches(cx); cx.notify(); })
        .child(label);
    }));
  }

  // One line for small events, a card for anything with text.
  event(i, icon, color, text, when) {
    const t = theme();
    return h_flex().id("ev-" + i).w_full().gap(8).py(3).items_start().text_size(12)
      .child(div().w(14).flex_none().text_color(color).child(icon))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(text))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(when)));
  }

  card(i, author, verb, verbColor, when, text) {
    const t = theme();
    return v_flex().gap(4).my(4).p(8).rounded(6).bg(t.background).border(1).border_color(t.border)
      .child(h_flex().gap(6).text_size(11)
        .child(div().font_semibold().text_color(t.foreground).child(author))
        .child(div().text_color(verbColor).child(verb))
        .child(div().flex_1())
        .child(div().text_color(t.dim).child(ago(when))))
      .when(text, (e) => e.child(this.body("c" + i, text)));
  }

  conversation() {
    const t = theme(), pr = this.pr;
    const out = [this.card("desc", who(pr.author), "opened", t.dim, pr.createdAt, pr.body || "_No description._")];
    const nodes = pr.timelineItems.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      switch (n.__typename) {
        case "PullRequestCommit": {
          let j = i; const commits = [];
          while (j < nodes.length && nodes[j].__typename === "PullRequestCommit") commits.push(nodes[j++].commit);
          const id = "commits-" + i, open = this.open[id], c0 = commits[0];
          const by = c0.author?.user?.login || c0.author?.name || "";
          out.push(v_flex().child(h_flex().id(id).w_full().cursor_pointer().on_click((_e, cx) => { this.open[id] = !open; cx.notify(); })
            .child(this.event(i, "●", t.dim, commits.length === 1 ? `${by} committed: ${c0.messageHeadline}` : `${by} pushed ${commits.length} commits ${open ? "▾" : "▸"}`, commits[commits.length - 1].committedDate)))
            .when(open && commits.length > 1, (e) => e.children(commits.map((c) => h_flex().gap(8).pl(22).text_size(11).text_color(t.muted)
              .child(div().font_family(MONO).text_color(t.dim).child(c.oid.slice(0, 7)))
              .child(div().flex_1().min_w(0).truncate().child(c.messageHeadline))))));
          i = j - 1;
          break;
        }
        case "LabeledEvent": case "UnlabeledEvent": {
          // Consecutive label changes by the same person become one line.
          let j = i; const added = [], removed = [];
          while (j < nodes.length && /^(Labeled|Unlabeled)Event$/.test(nodes[j].__typename) && who(nodes[j].actor) === who(n.actor)) {
            (nodes[j].__typename === "LabeledEvent" ? added : removed).push(nodes[j].label); j++;
          }
          out.push(h_flex().gap(8).py(3).items_center().flex_wrap().text_size(12)
            .child(div().w(14).flex_none().text_color(t.dim).child("◆"))
            .child(div().text_color(t.muted).child(who(n.actor)))
            .when(added.length, (e) => e.child(div().text_color(t.muted).child("added")).children(added.map((l) => this.chip(l))))
            .when(removed.length, (e) => e.child(div().text_color(t.muted).child(added.length ? "and removed" : "removed")).children(removed.map((l) => this.chip(l).opacity(0.6))))
            .child(div().flex_1())
            .child(div().text_size(11).text_color(t.dim).child(ago(nodes[j - 1].createdAt))));
          i = j - 1;
          break;
        }
        case "IssueComment":
          out.push(this.card(i, who(n.author), "commented", t.dim, n.createdAt, n.body));
          break;
        case "PullRequestReview": {
          const v = { APPROVED: ["approved", t.ansi2, "✓"], CHANGES_REQUESTED: ["requested changes", t.ansi1, "✗"], COMMENTED: ["reviewed", t.dim, "○"], DISMISSED: ["review dismissed", t.dim, "○"] }[n.state] || [n.state.toLowerCase(), t.dim, "○"];
          if (n.body?.trim()) out.push(this.card(i, who(n.author), v[0], v[1], n.createdAt, n.body));
          else out.push(this.event(i, v[2], v[1], `${who(n.author)} ${v[0]}`, n.createdAt));
          break;
        }
        case "ReviewRequestedEvent":
          out.push(this.event(i, "○", t.dim, `${who(n.actor)} requested review from ${n.requestedReviewer?.login || n.requestedReviewer?.name || "someone"}`, n.createdAt));
          break;
        case "MergedEvent": out.push(this.event(i, "⇄", t.ansi5, `${who(n.actor)} merged`, n.createdAt)); break;
        case "ClosedEvent": if (pr.state !== "MERGED") out.push(this.event(i, "✗", t.blocked, `${who(n.actor)} closed`, n.createdAt)); break;
        case "ReopenedEvent": out.push(this.event(i, "↺", t.ansi2, `${who(n.actor)} reopened`, n.createdAt)); break;
        case "ReadyForReviewEvent": out.push(this.event(i, "◉", t.ansi2, `${who(n.actor)} marked ready for review`, n.createdAt)); break;
        case "ConvertToDraftEvent": out.push(this.event(i, "◌", t.muted, `${who(n.actor)} converted to draft`, n.createdAt)); break;
        case "HeadRefForcePushedEvent": out.push(this.event(i, "↑", t.dim, `${who(n.actor)} force-pushed`, n.createdAt)); break;
      }
    }
    return out;
  }

  threads() {
    const t = theme(), list = [...this.pr.reviewThreads.nodes];
    if (!list.length) return [div().p(8).text_size(12).text_color(t.dim).child("No review threads.")];
    list.sort((a, b) => a.isResolved - b.isResolved);
    return list.map((th, i) => {
      const id = "th-" + i, open = this.open[id] ?? !th.isResolved;
      const cs = th.comments.nodes, first = cs[0];
      const status = th.isResolved ? ["Resolved", t.ansi2] : th.isOutdated ? ["Outdated", t.muted] : ["Unresolved", t.ansi3];
      return v_flex().my(3).rounded(6).border(1).border_color(t.border).bg(t.background)
        .child(h_flex().id(id).gap(8).px(8).py(5).items_center().cursor_pointer().text_size(11)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.open[id] = !open; cx.notify(); })
          .child(div().text_color(t.dim).child(open ? "▾" : "▸"))
          .child(this.badge(status[0], status[1]))
          .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_color(t.muted).child(`${th.path}${th.line ?? th.originalLine ? ":" + (th.line ?? th.originalLine) : ""}`))
          .child(div().text_color(t.dim).child(`${who(first?.author)}${cs.length > 1 ? ` +${cs.length - 1}` : ""}`)))
        .when(!open && first, (e) => e.child(div().px(8).pb(6).text_size(12).text_color(t.muted).truncate().child((first.body || "").replace(/\s+/g, " "))))
        .when(open, (e) => e.child(v_flex().px(8).pb(6).gap(6).children(cs.map((c, k) => v_flex().gap(2).pt(4).when(k, (e) => e.border_t(1).border_color(t.border))
          .child(h_flex().gap(6).text_size(11).child(div().font_semibold().child(who(c.author))).child(div().text_color(t.dim).child(ago(c.createdAt))))
          .child(this.body(`${id}-${k}`, c.body))))));
    });
  }

  diff(path) {
    const t = theme();
    if (this.patchError) return div().px(8).pb(6).text_size(11).text_color(t.blocked).child(this.patchError);
    if (!this.patches) return div().px(8).pb(6).text_size(11).text_color(t.dim).child("Loading diff…");
    const patch = this.patches[path];
    if (patch == null) return div().px(8).pb(6).text_size(11).text_color(t.dim).child("No text diff (binary or too large).");
    const lines = patch.split("\n"), shown = lines.slice(0, DIFF_MAX);
    return v_flex().mx(8).mb(6).p(6).rounded(4).bg(t.canvas).font_family(MONO).text_size(11).overflow_x_scroll()
      .children(shown.map((l) => {
        const c = l[0] === "+" ? t.ansi2 : l[0] === "-" ? t.ansi1 : l.startsWith("@@") ? t.accent : t.muted;
        const bg = l[0] === "+" ? t.ansi2 + "18" : l[0] === "-" ? t.ansi1 + "18" : null;
        return div().whitespace_nowrap().text_color(c).when(bg, (e) => e.bg(bg)).child(indent(l) || " ");
      }))
      .when(lines.length > DIFF_MAX, (e) => e.child(div().pt(4).text_color(t.dim).child(`… ${lines.length - DIFF_MAX} more lines, open on GitHub`)));
  }

  files() {
    const t = theme(), files = this.pr.files.nodes;
    const kind = { ADDED: ["A", t.ansi2], DELETED: ["D", t.ansi1], RENAMED: ["R", t.accent], COPIED: ["C", t.accent], CHANGED: ["M", t.ansi3], MODIFIED: ["M", t.ansi3] };
    const out = files.map((f, i) => {
      const id = "f-" + i, open = this.open[id], k = kind[f.changeType] || ["M", t.ansi3];
      const slash = f.path.lastIndexOf("/");
      return v_flex().border_b(1).border_color(t.border)
        .child(h_flex().id(id).gap(8).px(8).py(4).items_center().cursor_pointer().text_size(12)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.open[id] = !open; this.loadPatches(cx); cx.notify(); })
          .child(div().w(10).text_color(t.dim).child(open ? "▾" : "▸"))
          .child(div().w(12).font_family(MONO).text_color(k[1]).child(k[0]))
          .child(h_flex().flex_1().min_w(0).truncate()
            .child(div().text_color(t.dim).child(slash >= 0 ? f.path.slice(0, slash + 1) : ""))
            .child(div().text_color(t.foreground).child(f.path.slice(slash + 1))))
          .child(div().font_family(MONO).text_size(11).text_color(t.ansi2).child("+" + f.additions))
          .child(div().font_family(MONO).text_size(11).text_color(t.ansi1).child("−" + f.deletions)))
        .when(open, (e) => e.child(this.diff(f.path)));
    });
    if (this.pr.changedFiles > files.length) out.push(div().p(8).text_size(11).text_color(t.dim).child(`${this.pr.changedFiles - files.length} more files on GitHub.`));
    return out;
  }

  render(cx) {
    const t = theme();
    const root = v_flex().id("pr-review").size_full().bg(t.surface).text_size(13).text_color(t.foreground);
    const msg = (text, color) => root.child(v_flex().flex_1().items_center().justify_center().p(16).gap(8)
      .child(div().text_color(color).child(text)));
    if (!this.target()) return msg("Pick a pull request in the Pull requests panel.", t.dim);
    if (!this.pr) {
      if (this.error) return msg(this.error, t.blocked).child(h_flex().justify_center().pb(16).child(this.btn("pr-retry", "Retry", {}, (_e, cx) => this.load(cx))));
      return msg(`Loading #${this.target().number}…`, t.dim);
    }
    const content = this.tab === "threads" ? this.threads() : this.tab === "files" ? this.files() : this.conversation();
    return root
      .child(this.header())
      .child(this.tabs())
      .when(this.error, (e) => e.child(div().px(12).py(4).text_size(11).text_color(t.blocked).child(this.error)))
      .child(v_flex().id("pr-scroll-" + this.tab).flex_1().min_h(0).overflow_y_scrollbar()
        .px(this.tab === "files" ? 0 : 10).py(6).children(content));
  }
}
