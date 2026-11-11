import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, theme, props, layout, run } from "herdr";

const GH = ["gh", "C:/Program Files/GitHub CLI/gh.exe"];
const FIELDS = "number,title,author,labels,isDraft,updatedAt,url,reviewDecision,headRefName,state";

function where() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, machine: space?.machine ?? null };
}

async function gh(args, cwd) {
  let last;
  for (const bin of GH) {
    try { return await exec(bin, args, { cwd, timeout: 30000 }); } catch (e) { last = e; }
  }
  throw new Error("GitHub CLI (gh) not found: " + String(last?.message || last));
}

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  return Math.round(s / 86400) + "d";
}

export default class PullRequests extends View {
  init(_p, cx) {
    this.state = "open"; this.mine = false; this.data = null; this.error = null; this.repo = null; this.loading = false;
    this.refresh(cx);
    cx.timer.every(4000, (cx) => this.refresh(cx));
  }

  refresh(cx, force) {
    if (props()?.role === "toggle") return;
    const { cwd, machine } = where();
    const ctx = `${machine}|${cwd}|${this.state}|${this.mine}`;
    if (this.loading) return;
    if (ctx !== this.ctx) { this.ctx = ctx; this.data = null; this.error = null; }
    else if (!force && this.data && Date.now() - this.at < 25000) return;
    if (machine) { this.error = "Remote machines are not supported."; cx.notify(); return; }
    if (!cwd) return;
    this.loading = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await gh(["pr", "list", "--state", this.state, "--limit", "50", ...(this.mine ? ["--author", "@me"] : []), "--json", FIELDS], cwd);
        if (this.ctx !== ctx) return;
        if (r.code !== 0) { this.data = null; this.error = (r.stderr || r.stdout || "gh failed").trim().split("\n")[0]; }
        else { this.data = JSON.parse(r.stdout || "[]"); this.error = null; this.at = Date.now(); }
        const n = await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd).catch(() => null);
        this.repo = n && n.code === 0 ? n.stdout.trim() : this.repo;
      } catch (e) { this.error = String(e?.message || e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  setState(s, cx) { this.state = s; this.refresh(cx, true); cx.notify(); }

  setMine(cx) { this.mine = !this.mine; this.refresh(cx, true); cx.notify(); }

  toggle() {
    const t = theme();
    const find = (n) => n?.id === "pull-requests-panel" ? n : (n?.children || []).map(find).find(Boolean);
    const open = !find(layout())?.hidden;
    return h_flex().size_full().items_center().px(6).child(
      h_flex().id("pr-toggle").h(28).px(10).items_center().rounded(6).text_size(13)
        .bg(open ? t.selected : t.chrome).text_color(open ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click(() => run("layout.toggle", { id: "pull-requests-panel" }))
        .child("Pull requests"));
  }

  chip(label) {
    const t = theme(), c = "#" + (label.color || "888888");
    return div().px(6).rounded(4).text_size(11).text_color(t.foreground).bg(c + "44").border(1).border_color(c).child(label.name);
  }

  row(pr) {
    const t = theme();
    const status = pr.state === "MERGED" ? ["merged", t.done] : pr.state === "CLOSED" ? ["closed", t.blocked] : pr.isDraft ? ["draft", t.muted] : null;
    const review = pr.reviewDecision === "APPROVED" ? ["approved", t.working] : pr.reviewDecision === "CHANGES_REQUESTED" ? ["changes requested", t.blocked] : null;
    return v_flex().id("pr-" + pr.number).gap(4).py(7).rounded(6).px(4)
      .hover((s) => s.bg(t.hover))
      .on_click(() => exec("cmd", ["/c", "start", "", pr.url]).catch(() => null))
      .child(h_flex().gap(8).items_center()
        .child(div().text_color(t.dim).child("#" + pr.number))
        .child(div().flex_1().truncate().child(pr.title))
        .when(status, (e) => e.child(div().text_size(11).text_color(status[1]).child(status[0]))))
      .child(h_flex().gap(8).text_size(11).text_color(t.dim)
        .child(div().child(pr.author?.login || ""))
        .child(div().truncate().child(pr.headRefName))
        .child(div().child(ago(pr.updatedAt)))
        .when(review, (e) => e.child(div().text_color(review[1]).child(review[0]))))
      .when(pr.labels?.length, (e) => e.child(h_flex().gap(4).flex_wrap().children(pr.labels.map((l) => this.chip(l)))));
  }

  mineButton() {
    const t = theme(), on = this.mine;
    return div().id("pr-mine").px(8).py(2).rounded(5).text_size(12)
      .bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.setMine(cx))
      .child("Mine");
  }

  filter(name, label) {
    const t = theme(), on = this.state === name;
    return div().id("pr-f-" + name).px(8).py(2).rounded(5).text_size(12)
      .bg(on ? t.selected : t.surface).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.setState(name, cx))
      .child(label);
  }

  render(cx) {
    if (props()?.role === "toggle") return this.toggle();
    const t = theme(), d = this.data;
    const body = v_flex().id("pr-body").flex_1().overflow_y_scrollbar().px(8).pb(12);
    if (this.error) body.child(div().p(8).text_color(t.blocked).child(this.error));
    else if (d && !d.length) body.child(div().p(8).text_color(t.dim).child("No " + (this.state === "all" ? "" : this.state + " ") + "pull requests" + (this.mine ? " by you." : ".")));
    else if (d) body.children(d.map((p) => this.row(p)));
    else body.child(div().p(8).text_color(t.dim).child("Loading…"));
    return v_flex().size_full().bg(t.surface).text_size(13).text_color(t.foreground)
      .child(v_flex().px(12).py(10).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().items_center().gap(8)
          .child(div().flex_1().font_semibold().child("Pull requests"))
          .child(div().text_size(11).text_color(t.dim).child(this.loading ? "refreshing…" : d ? d.length + " shown" : "")))
        .child(div().truncate().text_size(11).text_color(t.dim).child(this.repo || ""))
        .child(h_flex().gap(4).child(this.filter("open", "Open")).child(this.filter("merged", "Merged")).child(this.filter("all", "All"))
          .child(div().flex_1())
          .child(this.mineButton())))
      .child(body);
  }
}
