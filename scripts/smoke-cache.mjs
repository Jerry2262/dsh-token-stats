// Cache-hit-rate smoke (no DSH needed).
//
// The client half is a plain `window.__ModuleLoader__.load({ factory })` script,
// so this harness runs it in a vm sandbox with a tiny React stand-in and a
// controllable `tokenStats.getStats` payload, renders the Settings page, and
// asserts the resulting element tree. It covers what the host-side smokes
// cannot:
//   - the range-level hit-rate aggregation and its output-only division guard,
//   - UI wiring: the "缓存命中率" summary card and the bar-chart tooltip,
//   - the deliberately removed price-tier block (kept out so the page stays
//     compact — the top card is the only persistent readout).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "client.js"), "utf8");

// ---- tiny React stand-in ---------------------------------------------------
// Just enough hooks for this bundle: element creation, function components,
// useState/useRef/useCallback/useEffect, refs on host elements, and automatic
// re-render after state changes. Effects run once per component (the bundle's
// effects are plain [] / [data] effects; the harness only needs the [] case).
function createHarness() {
  const instances = new Map();
  let current = null;
  let pendingEffects = [];
  let dirty = false;

  function flatten(children) {
    const out = [];
    const push = (c) => {
      if (c == null || c === false || c === true) return;
      if (Array.isArray(c)) {
        c.forEach(push);
        return;
      }
      out.push(c);
    };
    children.forEach(push);
    return out;
  }

  function createElement(type, props, ...children) {
    return { __type: type, props: props || {}, children: flatten(children) };
  }

  function alloc(kind) {
    const inst = current;
    const i = inst.cursor++;
    let slot = inst.hooks[i];
    if (!slot || slot.kind !== kind) {
      slot = { kind };
      inst.hooks[i] = slot;
    }
    return slot;
  }

  function useState(initial) {
    const slot = alloc("state");
    if (!slot.init) {
      slot.init = true;
      slot.value = typeof initial === "function" ? initial() : initial;
    }
    const set = (next) => {
      const value = typeof next === "function" ? next(slot.value) : next;
      if (!Object.is(value, slot.value)) {
        slot.value = value;
        dirty = true;
      }
    };
    return [slot.value, set];
  }

  function useRef(initial) {
    const slot = alloc("ref");
    if (!slot.init) {
      slot.init = true;
      slot.value = { current: initial === undefined ? null : initial };
    }
    return slot.value;
  }

  function useCallback(fn) {
    alloc("callback");
    return fn;
  }

  function useEffect(fn) {
    const slot = alloc("effect");
    if (!slot.ran) {
      slot.ran = true;
      pendingEffects.push({ slot, fn });
    }
  }

  function domNode() {
    return { clientWidth: 720, style: {}, remove() {} };
  }

  function renderNode(node) {
    if (node == null || node === false || node === true) return null;
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(renderNode);
    const type = node.__type;
    const props = node.props || {};
    if (typeof type === "function") {
      let inst = instances.get(type);
      if (!inst) {
        inst = { hooks: [], cursor: 0 };
        instances.set(type, inst);
      }
      const prev = current;
      current = inst;
      inst.cursor = 0;
      try {
        return renderNode(type(props));
      } finally {
        current = prev;
      }
    }
    const ref = props.ref;
    if (ref && typeof ref === "object") ref.current = domNode();
    if (typeof ref === "function") ref(domNode());
    return { tag: String(type), props, children: node.children.map(renderNode) };
  }

  function runEffects() {
    const list = pendingEffects;
    pendingEffects = [];
    for (const item of list) item.slot.cleanup = item.fn();
  }

  async function render(element) {
    let tree = null;
    for (let pass = 0; pass < 20; pass++) {
      dirty = false;
      tree = renderNode(element);
      runEffects();
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      if (!dirty) return tree;
    }
    throw new Error("render did not settle within 20 passes (update loop?)");
  }

  return {
    React: { createElement, useState, useRef, useCallback, useEffect },
    render,
  };
}

// ---- fake browser / ctx ----------------------------------------------------

function makeSandbox(remote) {
  let captured = null;
  const registrations = [];
  const slots = {
    inject(slot, thunk) {
      if (slot === "settings.section") registrations.push(slot);
      return thunk();
    },
    register(spec) {
      return () => {};
    },
  };
  const sandbox = {
    console: { warn() {}, error() {}, log() {} },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      constructor(cb) {
        this.cb = cb;
      }
      observe(el) {
        this.cb([{ target: el }]);
      }
      disconnect() {}
    },
    document: {
      createElement: () => ({ remove() {} }),
      head: { appendChild() {} },
      querySelectorAll: () => [],
      body: {},
    },
    window: {},
  };
  sandbox.window.__ModuleLoader__ = {
    load(entry) {
      captured = entry;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  if (!captured) throw new Error("bundle did not register via __ModuleLoader__.load");
  const harness = createHarness();
  const exports = captured.factory((name) => {
    if (name === "react") return harness.React;
    throw new Error("unexpected require: " + name);
  });
  const pages = [];
  const ctx = {
    remote: {
      async $mount() {},
    },
    get(name) {
      return name === "remote.tokenStats" ? remote : undefined;
    },
    effect(fn) {
      return fn();
    },
    slots: {
      inject(slot, thunk) {
        return thunk();
      },
      register(spec, component) {
        if (spec && spec.name === "settings.section") pages.push(component);
        return () => {};
      },
    },
    inject(deps, cb) {
      cb({ slots, modelDirectories: {} });
    },
  };
  return { exports, ctx, harness, pages };
}

// ---- tree helpers ----------------------------------------------------------

function textOf(node, sep = " ") {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => textOf(n, sep)).filter(Boolean).join(sep);
  return textOf(node.children, sep);
}

function collect(node, predicate) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n === "string") return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (predicate(n)) out.push(n);
    walk(n.children);
  };
  walk(node);
  return out;
}

function byClass(tree, cls) {
  return collect(tree, (n) => String((n.props && n.props.className) || "").split(/\s+/).includes(cls));
}

function byTag(tree, tag) {
  return collect(tree, (n) => n.tag === tag);
}

// ---- assertions ------------------------------------------------------------

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("ok -", name);
  } else {
    failures += 1;
    console.error("FAIL -", name + (detail ? ": " + detail : ""));
  }
}

function includesText(node, needle) {
  return textOf(node).includes(needle);
}

// ---- fixtures --------------------------------------------------------------

const M = 1_000_000;

function todayKey() {
  const d = new Date();
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

function statsPayload(models) {
  return {
    ready: true,
    collecting: false,
    progress: { done: 0, total: 0 },
    error: null,
    days: [
      {
        date: todayKey(),
        total: models.reduce((s, m) => s + m.total, 0),
        models,
      },
    ],
    models: models.map((m) => ({ key: m.key, name: m.name, provider: m.provider })),
  };
}

function makeRemote(payload) {
  return {
    async getStats() {
      return { ok: true, value: { ok: true, value: payload } };
    },
    async getQuota() {
      return { ok: true, value: { ok: true, value: { provider: "deepseek", display: {} } } };
    },
    async getAllQuotas() {
      return { ok: true, value: { ok: true, value: { quotas: {} } } };
    },
  };
}

async function renderPage(payload) {
  const { exports, ctx, harness, pages } = makeSandbox(makeRemote(payload));
  await exports.apply(ctx);
  if (pages.length !== 1) throw new Error("expected one settings.section page, got " + pages.length);
  const tree = await harness.render(harness.React.createElement(pages[0], {}));
  return tree;
}

// ---- scenario 1: mixed providers, 75% cache hit ---------------------------

async function scenarioMixed() {
  console.log("\n[scenario] mixed providers (75% hit + a cold model)");
  const payload = statsPayload([
    {
      key: "deepseek-official::deepseek-flash",
      name: "deepseek-flash",
      provider: "deepseek-official",
      input: 1 * M,
      output: 1 * M,
      cacheRead: 3 * M,
      cacheWrite: 0,
      reasoning: 0,
      total: 5 * M,
    },
    {
      key: "openai-codex::gpt-6.1-sol",
      name: "gpt-6.1-sol",
      provider: "openai-codex",
      input: 200 * 1e3,
      output: 300 * 1e3,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 500 * 1e3,
    },
  ]);
  const tree = await renderPage(payload);

  const cards = byClass(tree, "ts-card");
  check("summary shows total tokens 5.5M", cards.some((c) => includesText(c, "总 Tokens") && includesText(c, "5.5M")));
  check(
    "summary shows the overall hit rate 71.4%",
    cards.some((c) => includesText(c, "缓存命中率") && includesText(c, "71.4%")),
    cards.map((c) => textOf(c)).join(" | "),
  );

  const titles = byClass(tree, "ts-block-title").map((n) => textOf(n));
  check("price-tier block is no longer rendered", !titles.includes("缓存命中率 · 价格档位"), titles.join(" | "));
  check(
    "block-only classes are gone",
    byClass(tree, "ts-tier-bar").length === 0 && byClass(tree, "ts-cache-table").length === 0,
  );

  const tooltips = byTag(tree, "title").map((n) => textOf(n));
  check(
    "bar tooltip carries the per-day hit rate",
    tooltips.some((t) => t.includes("deepseek-flash: 5.0M · 命中 75%")),
    tooltips.filter((t) => t.includes("deepseek-flash")).join(" | "),
  );
}

// ---- scenario 2: output-only model (prompt total 0) -----------------------

async function scenarioOutputOnly() {
  console.log("\n[scenario] output-only model (no prompt tokens)");
  const payload = statsPayload([
    {
      key: "p::output-only",
      name: "output-only",
      provider: "p",
      input: 0,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 100,
    },
  ]);
  const tree = await renderPage(payload);

  const cards = byClass(tree, "ts-card");
  check(
    "hit-rate card renders a dash instead of dividing by zero",
    cards.some((c) => includesText(c, "缓存命中率") && includesText(c, "—")),
    cards.map((c) => textOf(c)).join(" | "),
  );
}

// ---- scenario 3: empty dataset -------------------------------------------

async function scenarioEmpty() {
  console.log("\n[scenario] empty dataset");
  const payload = { ready: true, collecting: false, progress: { done: 0, total: 0 }, error: null, days: [], models: [] };
  const tree = await renderPage(payload);

  const titles = byClass(tree, "ts-block-title").map((n) => textOf(n));
  check("no cache block without data", !titles.includes("缓存命中率 · 价格档位"), titles.join(" | "));
  const cards = byClass(tree, "ts-card");
  check(
    "summary still renders with a dash hit rate",
    cards.some((c) => includesText(c, "缓存命中率") && includesText(c, "—")),
    cards.map((c) => textOf(c)).join(" | "),
  );
  check("page itself renders", includesText(tree, "Token 用量统计"));
}

await scenarioMixed();
await scenarioOutputOnly();
await scenarioEmpty();

console.log("");
if (failures > 0) {
  console.error("smoke:cache FAILED (" + failures + " assertion(s))");
  process.exitCode = 1;
} else {
  console.log("smoke:cache passed");
}
