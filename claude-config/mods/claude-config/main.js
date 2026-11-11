import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, home, theme, props, layout, run } from "herdr";
import * as fs from "fs/promises";

// Where is the focused terminal? (local machine only)
function where() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder || null, machine: space?.machine ?? null };
}

const BS = String.fromCharCode(92);
const fwd = (s) => s.split(BS).join("/");
const join = (...p) => fwd(p.join("/")).split("//").join("/");
async function json(path) {
  try { const t = await readTextFile(path); return t ? JSON.parse(t) : null; } catch { return null; }
}
async function ls(dir) {
  try { return await fs.readdir(dir); } catch { return []; }
}
async function skillsIn(dir) {
  const out = [];
  for (const name of await ls(dir)) {
    const text = await readTextFile(join(dir, name, "SKILL.md")).catch(() => null);
    if (text == null) continue;
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const d = m && /^description:\s*(.+)$/m.exec(m[1]);
    out.push({ name, detail: d ? d[1].replace(/^["']|["']$/g, "").trim() : "" });
  }
  return out;
}
async function editLocal(root, fn) {
  const path = join(root, ".claude/settings.local.json");
  const text = await readTextFile(path).catch(() => null);
  const obj = text ? JSON.parse(text) : {};
  fn(obj);
  if (text == null) await exec("powershell", ["-NoProfile", "-Command", "New-Item -ItemType Directory -Force -Path '" + join(root, ".claude") + "' | Out-Null"]).catch(() => null);
  await writeTextFile(path, JSON.stringify(obj, null, 2) + String.fromCharCode(10), text ?? null);
}
const list = (o, k) => (o[k] = Array.isArray(o[k]) ? o[k] : []);
const add = (a, v) => { if (!a.includes(v)) a.push(v); };
const del = (a, v) => { const i = a.indexOf(v); if (i >= 0) a.splice(i, 1); };

const mcpDetail = (s) => s?.url || [s?.command, ...(s?.args || [])].filter(Boolean).join(" ") || s?.type || "";

async function gather(cwd) {
  const H = fwd(home());
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd }).catch(() => null);
  const root = fwd(top && top.code === 0 ? top.stdout.trim() : cwd);
  const [user, proj, local, installed, claudeJson, dotMcp] = await Promise.all([
    json(join(H, ".claude/settings.json")), json(join(root, ".claude/settings.json")),
    json(join(root, ".claude/settings.local.json")), json(join(H, ".claude/plugins/installed_plugins.json")),
    json(join(H, ".claude.json")), json(join(root, ".mcp.json")),
  ]);

  const denied = new Map(); // rule -> sources
  for (const [src, st] of [["global", user], ["repo", proj], ["local", local]])
    for (const r of st?.permissions?.deny || []) denied.set(r, [...(denied.get(r) || []), src]);

  // Plugins: the most specific settings file that mentions a plugin decides.
  const plugins = new Map();
  const layers = [["global", user], ["repo", proj], ["local", local]];
  for (const [src, s] of layers)
    for (const [id, on] of Object.entries(s?.enabledPlugins || {})) {
      const p = plugins.get(id) || { id }; p.enabled = !!on; p.source = src; plugins.set(id, p);
    }
  for (const [id, list] of Object.entries(installed?.plugins || {})) {
    const p = plugins.get(id) || { id, enabled: false, source: "installed only" };
    p.install = list[0]; p.version = list[0]?.version; plugins.set(id, p);
  }
  for (const p of plugins.values()) p.act = { kind: "plugin", id: p.id, on: p.enabled };
  const pluginList = [...plugins.values()].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.id.localeCompare(b.id));

  // MCP servers: user (~/.claude.json), local-to-project (~/.claude.json projects), repo (.mcp.json).
  const mcp = [];
  for (const [n, s] of Object.entries(claudeJson?.mcpServers || {})) mcp.push({ name: n, source: "global", detail: mcpDetail(s) });
  for (const [k, v] of Object.entries(claudeJson?.projects || {}))
    if (fwd(k).toLowerCase() === root.toLowerCase())
      for (const [n, s] of Object.entries(v.mcpServers || {})) mcp.push({ name: n, source: "local", detail: mcpDetail(s) });
  const off = new Set([...(local?.disabledMcpjsonServers || []), ...(proj?.disabledMcpjsonServers || [])]);
  for (const [n, s] of Object.entries(dotMcp?.mcpServers || {})) mcp.push({ name: n, source: "repo", detail: mcpDetail(s), off: off.has(n) });
  for (const [n, s] of Object.entries(user?.mcpServers || {})) mcp.push({ name: n, source: "global", detail: mcpDetail(s) });
  for (const [n, s] of Object.entries(proj?.mcpServers || {})) mcp.push({ name: n, source: "repo", detail: mcpDetail(s) });

  // Skills: user, repo, and those shipped by enabled plugins.
  const skills = [];
  for (const s of await skillsIn(join(H, ".claude/skills"))) skills.push({ ...s, source: "global" });
  if (root !== H) for (const s of await skillsIn(join(root, ".claude/skills"))) skills.push({ ...s, source: "repo" });
  for (const p of pluginList) {
    if (!p.enabled || !p.install?.installPath) continue;
    const dir = join(p.install.installPath, "skills");
    for (const s of await skillsIn(dir)) skills.push({ ...s, source: `plugin ${p.id.split("@")[0]}` });
    const pm = await json(join(p.install.installPath, ".mcp.json"));
    for (const [n, s] of Object.entries(pm?.mcpServers || pm || {}))
      if (s && typeof s === "object") mcp.push({ name: n, source: `plugin ${p.id.split("@")[0]}`, detail: mcpDetail(s) });
  }
  for (const m of mcp) {
    if (m.source.startsWith("plugin")) continue;
    const rule = "mcp__" + m.name, by = denied.get(rule) || [];
    if (m.source === "repo" && dotMcp?.mcpServers?.[m.name]) {
      const byFile = (local?.disabledMcpjsonServers || []).includes(m.name) ? ["local"] : (proj?.disabledMcpjsonServers || []).includes(m.name) ? ["repo"] : [];
      m.off = byFile.length > 0 || by.length > 0; m.offBy = [...byFile, ...by];
      m.act = { kind: "dotmcp", name: m.name, on: !m.off };
    } else { m.off = by.length > 0; m.offBy = by; m.act = { kind: "deny", rule, on: !m.off }; }
  }
  for (const k of skills) {
    if (k.source.startsWith("plugin")) continue;
    const rule = "Skill(" + k.name + ")", by = denied.get(rule) || [];
    k.off = by.length > 0; k.offBy = by; k.act = { kind: "deny", rule, on: !k.off };
  }
  return { root, plugins: pluginList, mcp, skills };
}

export default class ClaudeConfig extends View {
  init(_p, cx) {
    this.data = null; this.error = null;
    this.refresh(cx);
    cx.timer.every(5000, (cx) => this.refresh(cx));
  }
  refresh(cx) {
    const { cwd, machine } = where();
    const ctx = `${machine}|${cwd}`;
    if (this.busy) return;
    if (machine) { this.data = null; this.error = "Remote machines are not supported."; this.ctx = ctx; cx.notify(); return; }
    if (!cwd) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try { this.data = await gather(cwd); this.error = null; this.cwd = cwd; }
      catch (e) { this.error = String(e?.message || e); }
      finally { this.busy = false; cx.notify(); }
    });
  }
  flip(act, cx) {
    const root = this.data.root;
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await editLocal(root, (o) => {
          if (act.kind === "plugin") { (o.enabledPlugins = o.enabledPlugins || {})[act.id] = !act.on; }
          else if (act.kind === "deny") {
            const d = list(o.permissions = o.permissions || {}, "deny");
            if (act.on) add(d, act.rule); else del(d, act.rule);
          } else if (act.kind === "dotmcp") {
            const dis = list(o, "disabledMcpjsonServers"), en = list(o, "enabledMcpjsonServers");
            if (act.on) { add(dis, act.name); del(en, act.name); } else { del(dis, act.name); add(en, act.name); }
          }
        });
        this.error = null;
      } catch (e) { this.error = "Write failed: " + String(e?.message || e); }
      this.busy = false; this.refresh(cx); cx.notify();
    });
  }
  badge(src) {
    const t = theme();
    const color = src === "global" ? t.accent : src === "repo" ? t.working : src === "local" ? t.done : t.muted;
    return div().px(6).rounded(4).text_size(11).text_color(color).border(1).border_color(color).child(src);
  }
  switch(it) {
    const t = theme();
    const blocked = !it.act.on && it.offBy && it.offBy.length && !it.offBy.includes("local") && it.act.kind !== "plugin";
    if (blocked) return div().text_size(11).text_color(t.dim).child("off (" + it.offBy.join("+") + ")");
    const on = it.act.on;
    return h_flex().id("sw-" + it.act.kind + (it.act.id || it.act.name || it.act.rule)).w(34).h(18).rounded(9).px(2).items_center()
      .bg(on ? t.accent : t.input).justify_start()
      .when(on, (e) => e.justify_end())
      .hover((s) => s.opacity(0.8))
      .on_click((_e, cx) => this.flip(it.act, cx))
      .child(div().w(14).h(14).rounded(7).bg(t.background));
  }
  row(name, src, detail, dim, it) {
    const t = theme();
    return v_flex().gap(2).py(5).child(
      h_flex().gap(8).items_center()
        .child(div().flex_1().truncate().text_color(dim ? t.dim : t.foreground).child(name))
        .child(this.badge(src))
        .when(it && it.act, (e) => e.child(this.switch(it))))
      .when(detail, (e) => e.child(div().truncate().text_size(11).text_color(t.dim).child(detail)));
  }
  section(title, items, render) {
    const t = theme();
    return v_flex().gap(2).child(div().pt(10).pb(2).text_size(12).font_semibold().text_color(t.muted).child(`${title} · ${items.length}`))
      .children(items.length ? items.map(render) : [div().text_size(12).text_color(t.dim).child("none")]);
  }
  toggle() {
    const t = theme();
    const find = (n) => n?.id === "claude-config-panel" ? n : (n?.children || []).map(find).find(Boolean);
    const open = !find(layout())?.hidden;
    return h_flex().size_full().items_center().px(6).child(
      h_flex().id("cc-toggle").h(28).px(10).gap(6).items_center().rounded(6).text_size(13)
        .bg(open ? t.selected : t.chrome).text_color(open ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click(() => run("layout.toggle", { id: "claude-config-panel" }))
        .child("Claude config"));
  }
  render(cx) {
    if (props()?.role === "toggle") return this.toggle();
    const t = theme(), d = this.data;
    const body = v_flex().id("cc-body").flex_1().overflow_y_scrollbar().px(12).pb(12);
    if (this.error) body.child(div().pt(10).text_color(t.blocked).child(this.error));
    if (d) {
      body.child(this.section("Plugins", d.plugins, (p) =>
        this.row(p.id, p.source, `${p.enabled ? "enabled" : "disabled"}${p.version ? " · v" + p.version : ""}`, !p.enabled, p)));
      body.child(this.section("MCP servers", d.mcp, (m) => this.row(m.name, m.source, (m.off ? "disabled · " : "") + m.detail, m.off, m)));
      body.child(this.section("Skills", d.skills, (s) => this.row(s.name, s.source, s.detail, s.off, s)));
      body.child(div().pt(12).text_size(11).text_color(t.dim).child("Switches write to .claude/settings.local.json (this project only), then apply on the next Claude session. Account connectors (claude.ai) are not readable from files."));
    } else if (!this.error) body.child(div().pt(10).text_color(t.dim).child("Loading…"));
    return v_flex().size_full().bg(t.surface).text_size(13).text_color(t.foreground)
      .child(v_flex().px(12).py(10).gap(2).border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Claude config"))
        .child(div().truncate().text_size(11).text_color(t.dim).child(d?.root || this.cwd || "")))
      .child(body);
  }
}
