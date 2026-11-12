// The merge button's dropdown in pr-review: merge method, delete-branch
// toggle, and Convert to draft / Close / Archive. Opened as a popup with props
// { uid, methods, method, deleteBranch, isDraft, state }. Method and toggle are
// saved in shared state; actions go back to the pane as
// shared("pr-review.menu") = { uid, action, at }, which runs them.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, shared, setShared } from "herdr";

const LABEL = { MERGE: "Create a merge commit", SQUASH: "Squash and merge", REBASE: "Rebase and merge" };
const HINT = {
  MERGE: "Keeps all commits, adds a merge commit",
  SQUASH: "Combines the commits into one",
  REBASE: "Replays the commits onto the base",
};

export default class PrMergeMenu extends View {
  init(_p, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  done(action) {
    const p = props();
    closeOverlay(p.overlay);
    setShared("pr-review.menu", { uid: p.uid, action, at: Date.now() });
  }

  row(id, icon, label, color, onClick, hint) {
    const t = theme();
    return h_flex().id(id).gap(10).px(10).py(hint ? 6 : 5).mx(4).rounded(6).items_start().cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(div().w(16).h(18).flex_none().flex().items_center().justify_center().text_color(color).child(icon))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(13).text_color(color).child(label))
        .when(hint, (e) => e.child(div().text_size(11).text_color(t.dim).child(hint))));
  }

  render() {
    const t = theme(), p = props() || {};
    const open = p.state === "OPEN", mergeable = open && !p.isDraft;
    const icon = (name, color) => svg(`mods/pr-merge-menu/${name}.svg`).size(15).text_color(color);
    const check = (on) => div().text_size(13).text_color(t.accent).child(on ? "✓" : "");
    const sep = () => div().h(1).my(4).bg(t.border);
    return v_flex().id("pr-menu").track_focus(this.handle).size_full().overflow_y_scrollbar().py(4).bg(t.popover).text_color(t.foreground)
      .when(mergeable, (e) => e
        .children((p.methods || []).map((m) => this.row("m-" + m, check(p.method === m), LABEL[m], t.foreground,
          () => { setShared("pr-review.method", m); closeOverlay(p.overlay); }, HINT[m])))
        .child(this.row("del", check(p.deleteBranch), "Delete branch after merge", t.foreground,
          () => { setShared("pr-review.deleteBranch", !p.deleteBranch); closeOverlay(p.overlay); }))
        .child(sep()))
      .when(mergeable, (e) => e.child(this.row("draft", icon("draft", t.muted), "Convert to draft", t.foreground, () => this.done("draft"))))
      .when(open, (e) => e.child(this.row("close", icon("close", t.ansi1), "Close pull request", t.ansi1, () => this.done("close"))))
      .when(p.state === "CLOSED", (e) => e.child(this.row("reopen", icon("reopen", t.ansi2), "Reopen pull request", t.foreground, () => this.done("reopen"))))
      .child(this.row("archive", icon("archive", t.muted), "Archive pull request", t.foreground, () => this.done("archive")));
  }
}
