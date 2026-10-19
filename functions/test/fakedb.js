// A small in-memory stand-in for the parts of Firestore the handlers use.
const OP = Symbol("op");
export const FieldValue = {
  increment: n => ({ [OP]: "inc", n }),
  delete: () => ({ [OP]: "del" }),
  arrayUnion: (...v) => ({ [OP]: "union", v }),
  arrayRemove: (...v) => ({ [OP]: "remove", v }),
  serverTimestamp: () => ({ [OP]: "ts" }),
};
export class Timestamp {
  constructor(ms) { this.ms = ms; }
  static fromMillis(ms) { return new Timestamp(ms); }
  toMillis() { return this.ms; }
}
export class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const isPlain = v => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Timestamp) && !v[OP];
const clone = v => (v instanceof Timestamp ? v : Array.isArray(v) ? v.map(clone) : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v);

function applyOp(old, v, clock) {
  if (!v || !v[OP]) return isPlain(v) ? resolve(v, clock) : clone(v);
  switch (v[OP]) {
    case "inc": return (typeof old === "number" ? old : 0) + v.n;
    case "union": return [...(old || []), ...v.v.filter(x => !(old || []).includes(x))];
    case "remove": return (old || []).filter(x => !v.v.includes(x));
    case "ts": return new Timestamp(clock());
  }
}
function resolve(obj, clock) {   // a fresh object with sentinels resolved
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!(v && v[OP] === "del")) out[k] = applyOp(undefined, v, clock);
  return out;
}
function mergeInto(target, src, clock) {
  for (const [k, v] of Object.entries(src)) {
    if (v && v[OP] === "del") delete target[k];
    else if (isPlain(v)) { if (!isPlain(target[k])) target[k] = {}; mergeInto(target[k], v, clock); }
    else target[k] = applyOp(target[k], v, clock);
  }
}
function setPath(target, path, v, clock) {
  const parts = path.split("."); let t = target;
  for (const p of parts.slice(0, -1)) { if (!isPlain(t[p])) t[p] = {}; t = t[p]; }
  const last = parts.at(-1);
  if (v && v[OP] === "del") delete t[last]; else t[last] = applyOp(t[last], v, clock);
}

let autoId = 0;
export function makeDb(clock = () => Date.now()) {
  const store = new Map();
  const snap = (path, data) => ({
    id: path.split("/").at(-1), exists: data !== undefined, ref: doc(path),
    data: () => clone(data), get: f => f.split(".").reduce((o, k) => (o == null ? undefined : o[k]), data),
  });
  const doc = path => ({
    path, id: path.split("/").at(-1), _doc: true,
    collection: c => collection(`${path}/${c}`),
    get: async () => snap(path, store.get(path)),
    set: async (d, o) => write.set({ path }, d, o),
    update: async d => write.update({ path }, d),
    delete: async () => write.delete({ path }),
  });
  const collection = path => {
    const q = { filters: [], order: null, lim: Infinity };
    const run = () => {
      let docs = [...store.entries()].filter(([p]) => p.startsWith(path + "/") && !p.slice(path.length + 1).includes("/"));
      const val = x => (x instanceof Timestamp ? x.ms : x);
      const test = { "==": (a, b) => a === b, ">=": (a, b) => a >= b, "<": (a, b) => a < b, ">": (a, b) => a > b, "<=": (a, b) => a <= b };
      const at = (d, f) => f.split(".").reduce((o, k) => (o == null ? undefined : o[k]), d);   // "stats.played" reaches inside
      docs = docs.filter(([, d]) => q.filters.every(([f, op, v]) => at(d, f) !== undefined && test[op](val(at(d, f)), val(v))));
      if (q.order) docs.sort((a, b) => ((a[1][q.order]?.ms ?? a[1][q.order]) > (b[1][q.order]?.ms ?? b[1][q.order]) ? 1 : -1));
      const out = docs.slice(0, q.lim).map(([p, d]) => snap(p, d));
      return { docs: out, size: out.length };
    };
    const api = {
      path, _query: true, run,
      doc: id => doc(`${path}/${id ?? "auto" + ++autoId}`),
      where: (f, op, v) => { q.filters.push([f, op, v]); return api; },
      count: () => ({ get: async () => ({ data: () => ({ count: run().docs.length }) }) }),
      orderBy: f => { q.order = f; return api; },
      limit: n => { q.lim = n; return api; },
      get: async () => run(),
    };
    return api;
  };
  const write = {
    set: (ref, data, opts) => {
      if (opts && opts.merge) { const t = clone(store.get(ref.path)) || {}; mergeInto(t, data, clock); store.set(ref.path, t); }
      else store.set(ref.path, resolve(data, clock));
    },
    update: (ref, data) => {
      if (!store.has(ref.path)) throw new Error("update on missing doc " + ref.path);
      const t = clone(store.get(ref.path));
      for (const [k, v] of Object.entries(data)) setPath(t, k, v, clock);
      store.set(ref.path, t);
    },
    delete: ref => store.delete(ref.path),
  };
  const writer = () => {
    const ops = [];
    return {
      set: (r, d, o) => { ops.push(() => write.set(r, d, o)); },
      update: (r, d) => { ops.push(() => write.update(r, d)); },
      delete: r => { ops.push(() => write.delete(r)); },
      flush: () => ops.forEach(f => f()),
    };
  };
  return {
    store,
    doc, collection,
    getAll: async (...refs) => refs.map(r => snap(r.path, store.get(r.path))),
    batch: () => { const w = writer(); return { ...w, commit: async () => w.flush() }; },
    runTransaction: async fn => {
      const w = writer();
      let wrote = false;
      const tx = {
        get: async r => { if (wrote) throw new Error("read after write in transaction"); return r._query ? r.run() : snap(r.path, store.get(r.path)); },
        set: (...a) => { wrote = true; w.set(...a); }, update: (...a) => { wrote = true; w.update(...a); }, delete: (...a) => { wrote = true; w.delete(...a); },
      };
      const res = await fn(tx);
      w.flush();
      return res;
    },
  };
}
