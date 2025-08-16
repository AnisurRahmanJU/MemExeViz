/*!
 * parser.js — Step generator for Memory Execution Visualizer
 * Source targets:
 *   1) Clang/LLVM JSON traces (AST- or runtime-instrumented events)
 *   2) WASM instrumentation events (postMessage/console-hook style)
 *
 * Goal: Convert heterogeneous traces to a unified `steps[]` format your UI expects:
 *   Step = {
 *     lines: number[],                // highlighted C source lines
 *     desc: string,                   // Bengali/English description
 *     stack: Frame[],                 // call stack top-last
 *     heap: HeapBlock[],              // heap snapshot
 *     stdout: string                  // accumulated console
 *   }
 *
 *   Frame = { name: string, locals: Var[] }
 *   Var   = { name, type, addr, size, value }
 *   HeapBlock = { addr, size, bytes?: (number|null)[], freed?: boolean, label?: string }
 *
 * No external dependencies. Works in browser and Node.
 * Attach to `window.MemVizParser` if running in browser.
 */

/* ---------------------- Config & Helpers ---------------------- */

const STACK_TOP = 0x7fffe000;  // stack grows downward
const HEAP_BASE = 0x10000000;  // heap grows upward

function toHex(n, pad = 8) {
  const v = (n >>> 0).toString(16).padStart(pad, "0");
  return "0x" + v;
}

function cloneDeep(x) {
  return JSON.parse(JSON.stringify(x));
}

function bytesFromIntLE(n, sz = 4) {
  // little-endian
  const out = [];
  let v = n >>> 0;
  for (let i = 0; i < sz; i++) {
    out.push(v & 0xff);
    v >>>= 8;
  }
  return out;
}

function strBytesWithNull(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
  out.push(0);
  return out;
}

function fmtVal(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return v;
  if (typeof v === "string") return v;
  return String(v);
}

/* ------------------ Runtime State (Builder) ------------------- */

class State {
  constructor() {
    this.frames = [];              // [{name, locals:[]}]
    this.heap = [];                // [{addr, size, bytes?, freed?}]
    this.stdout = "";
    this._stackCursor = STACK_TOP; // moves down
    this._heapCursor = HEAP_BASE;  // moves up
    this._retAddrCounter = 0x401000;
    this._addrBySym = new Map();   // symbol -> addr (for deterministic demos)
  }

  // ----- Stack -----
  pushFrame(name) {
    this.frames.push({ name, locals: [] });
  }
  popFrame() {
    this.frames.pop();
  }
  currentFrame() {
    return this.frames[this.frames.length - 1] || null;
  }

  allocLocal(name, type, size, initValue) {
    const f = this.currentFrame();
    if (!f) throw new Error("No active frame to allocate local");
    this._stackCursor -= Math.max(4, size);
    const addr = toHex(this._stackCursor);
    const v = { name, type, addr, size, value: initValue ?? 0 };
    f.locals.push(v);
    return v;
  }

  setLocal(name, value) {
    const f = this.currentFrame();
    if (!f) return;
    const v = f.locals.find(x => x.name === name);
    if (v) v.value = value;
  }

  getLocal(name) {
    const f = this.currentFrame();
    if (!f) return null;
    return f.locals.find(x => x.name === name) || null;
  }

  // ----- Heap -----
  malloc(size, label = "malloc") {
    const block = {
      addr: toHex(this._heapCursor),
      size,
      bytes: new Array(size).fill(0),
      label
    };
    this.heap.push(block);
    this._heapCursor += Math.max(4, size);
    return block;
  }

  free(addrHex) {
    const b = this.heap.find(h => h.addr === addrHex && !h.freed);
    if (b) {
      b.freed = true;
      b.label = "freed";
      b.bytes = b.bytes?.map(() => null);
    }
  }

  heapStore(addrHex, offset, byte) {
    const b = this.heap.find(h => h.addr === addrHex && !h.freed);
    if (!b) return;
    if (!b.bytes) b.bytes = new Array(b.size).fill(0);
    if (offset >= 0 && offset < b.size) b.bytes[offset] = byte;
  }

  // ----- Stdout -----
  print(s) { this.stdout += s; }

  // ----- Snapshots -----
  snapshot() {
    return {
      stack: cloneDeep(this.frames),
      heap: cloneDeep(this.heap),
      stdout: this.stdout
    };
  }

  // ----- Address helpers -----
  symAddr(sym, size = 4) {
    if (this._addrBySym.has(sym)) return this._addrBySym.get(sym);
    this._stackCursor -= Math.max(4, size);
    const a = toHex(this._stackCursor);
    this._addrBySym.set(sym, a);
    return a;
  }

  fakeRetAddr() {
    const a = toHex(this._retAddrCounter);
    this._retAddrCounter += 0x10;
    return a;
  }
}

/* ---------------- Unified Step Builder API ------------------- */

function makeStep({ lines = [], desc = "" }, state) {
  const snap = state.snapshot();
  return {
    lines,
    desc,
    stack: snap.stack,
    heap: snap.heap,
    stdout: snap.stdout
  };
}

/* --------------- CLANG JSON TRACE PARSER ---------------------
 * Accepts one of:
 *   A) "Runtime-like" event streams from custom instrumentation:
 *      { type, fn, line, name, vtype, size, value, bytes, addr, sizeBytes, text, ... }
 *      Supported types:
 *        - function_enter {fn, line}
 *        - function_exit  {fn, line}
 *        - local_alloc    {name, vtype, size, value, line}
 *        - local_set      {name, value, line}
 *        - store          {addr, bytes[], line}
 *        - malloc         {sizeBytes, sym?, line}
 *        - free           {addr, line}
 *        - printf         {text, line}
 *        - note           {text, line}  (description-only)
 *
 *   B) AST-like payload (clang -Xclang -ast-dump=json) — too static to
 *      animate execution on its own. We still accept it and synthesize
 *      a single descriptive step.
 */

function parseClangTrace(trace) {
  const state = new State();
  const steps = [];

  // If it looks like an AST JSON (has "kind":"TranslationUnitDecl"),
  // produce a single informative step.
  if (trace && typeof trace === "object" && !Array.isArray(trace) && trace.kind === "TranslationUnitDecl") {
    state.pushFrame("main");
    steps.push(makeStep({
      lines: [],
      desc: "প্রাপ্ত ইনপুটটি Clang AST JSON। AST থেকে রানটাইম স্টেপ জেনারেট করতে ইন্সট্রুমেন্টেড ইভেন্ট প্রয়োজন (e.g., -finstrument-functions বা কাস্টম লগ)।"
    }, state));
    return steps;
  }

  // Otherwise assume runtime-like event array:
  const events = Array.isArray(trace) ? trace : (trace?.events || []);
  if (!Array.isArray(events)) throw new Error("Invalid clang trace: expected events[]");

  for (const ev of events) {
    const line = Number.isFinite(ev.line) ? [ev.line] : [];

    switch (ev.type) {
      case "function_enter": {
        state.pushFrame(ev.fn || "func");
        steps.push(makeStep({
          lines: line,
          desc: `${ev.fn || "function"} কল শুরু; স্ট্যাক ফ্রেম তৈরি হলো`
        }, state));
        break;
      }
      case "function_exit": {
        steps.push(makeStep({
          lines: line,
          desc: `${ev.fn || "function"} থেকে রিটার্ন; স্ট্যাক ফ্রেম অপসারণ`
        }, state));
        state.popFrame();
        break;
      }
      case "local_alloc": {
        const v = state.allocLocal(ev.name, ev.vtype || "int", ev.size || 4, ev.value ?? 0);
        steps.push(makeStep({
          lines: line,
          desc: `লোকাল ভেরিয়েবল ${ev.name} (${v.type}, ${v.size} bytes) বরাদ্দ @ ${v.addr}${ev.value!=null?` = ${fmtVal(ev.value)}`:""}`
        }, state));
        break;
      }
      case "local_set": {
        state.setLocal(ev.name, ev.value);
        steps.push(makeStep({
          lines: line,
          desc: `লোকাল ${ev.name} = ${fmtVal(ev.value)}`
        }, state));
        break;
      }
      case "malloc": {
        const b = state.malloc(ev.sizeBytes || 4, ev.label || "malloc");
        if (ev.bytes && Array.isArray(ev.bytes)) {
          for (let i = 0; i < Math.min(b.size, ev.bytes.length); i++) state.heapStore(b.addr, i, ev.bytes[i]);
        }
        if (ev.sym) {
          // write address into a local pointer (if exists)
          const f = state.currentFrame();
          if (f) {
            const v = f.locals.find(x => x.name === ev.sym);
            if (v) v.value = b.addr;
          }
        }
        steps.push(makeStep({
          lines: line,
          desc: `হিপে ${b.size} বাইট বরাদ্দ @ ${b.addr} (${b.label})`
        }, state));
        break;
      }
      case "free": {
        state.free(ev.addr);
        steps.push(makeStep({
          lines: line,
          desc: `free(${ev.addr}); → ব্লক মুক্ত`
        }, state));
        break;
      }
      case "store": {
        // store to heap if address matches
        const addr = ev.addr;
        const bytes = ev.bytes || [];
        const b = state.heap.find(h => h.addr === addr && !h.freed);
        if (b) {
          bytes.forEach((bt, i) => state.heapStore(addr, i, bt));
          steps.push(makeStep({
            lines: line,
            desc: `হিপ ব্লক ${addr} তে ${bytes.length} বাইট লেখা`
          }, state));
          break;
        }
        // otherwise try local by address
        const f = state.currentFrame();
        if (f) {
          const v = f.locals.find(L => L.addr === addr);
          if (v) {
            if (v.type.startsWith("char") && bytes.length) {
              // interpret as string (null-terminated if present)
              const str = bytes.map(b => b ? String.fromCharCode(b) : "\0").join("").replace(/\0.*$/,"");
              v.value = str.split("");
            } else if (bytes.length === 4) {
              const n = (bytes[0] | (bytes[1]<<8) | (bytes[2]<<16) | (bytes[3]<<24)) >>> 0;
              v.value = n;
            } else {
              v.value = bytes.slice();
            }
            steps.push(makeStep({
              lines: line,
              desc: `স্ট্যাকে ${v.name} @ ${addr} আপডেট`
            }, state));
            break;
          }
        }
        steps.push(makeStep({ lines: line, desc: `store @ ${addr}` }, state));
        break;
      }
      case "printf": {
        state.print(ev.text || "");
        steps.push(makeStep({
          lines: line,
          desc: `printf → আউটপুটে "${(ev.text||"").replace(/\n/g, "\\n")}"`
        }, state));
        break;
      }
      case "note": {
        steps.push(makeStep({ lines: line, desc: ev.text || "নোট" }, state));
        break;
      }
      default: {
        steps.push(makeStep({
          lines: line,
          desc: `অচেনা ইভেন্ট: ${ev.type}`
        }, state));
      }
    }
  }

  return steps;
}

/* ---------------- WASM INSTRUMENTATION PARSER -----------------
 * Input: array of events you emit from a WASM runtime shim, e.g.:
 *   { kind:"call", fn:"main", line:9 }
 *   { kind:"ret", fn:"main", line:12 }
 *   { kind:"alloc_local", name:"x", vtype:"i32", size:4, value:42, line:10 }
 *   { kind:"malloc", size:4, sym:"p", line:11 }
 *   { kind:"store_mem", addr:"0x10000000", offset:0, byte:99, line:12 }
 *   { kind:"print", text:"hello\n", line:13 }
 */

function parseWasmTrace(events) {
  const state = new State();
  const steps = [];

  for (const ev of events || []) {
    const line = Number.isFinite(ev.line) ? [ev.line] : [];

    switch (ev.kind) {
      case "call": {
        state.pushFrame(ev.fn || "func");
        steps.push(makeStep({ lines: line, desc: `${ev.fn || "function"} কল` }, state));
        break;
      }
      case "ret": {
        steps.push(makeStep({ lines: line, desc: `${ev.fn || "function"} রিটার্ন` }, state));
        state.popFrame();
        break;
      }
      case "alloc_local": {
        const v = state.allocLocal(ev.name, ev.vtype || "i32", ev.size || 4, ev.value ?? 0);
        steps.push(makeStep({
          lines: line,
          desc: `লোকাল ${ev.name} (${v.type}) বরাদ্দ @ ${v.addr}${ev.value!=null?` = ${fmtVal(ev.value)}`:""}`
        }, state));
        break;
      }
      case "set_local": {
        state.setLocal(ev.name, ev.value);
        steps.push(makeStep({ lines: line, desc: `লোকাল ${ev.name} = ${fmtVal(ev.value)}` }, state));
        break;
      }
      case "malloc": {
        const b = state.malloc(ev.size || 4, "malloc");
        const f = state.currentFrame();
        if (f && ev.sym) {
          const pv = f.locals.find(x => x.name === ev.sym);
          if (pv) pv.value = b.addr;
        }
        steps.push(makeStep({ lines: line, desc: `হিপে ${b.size} বাইট @ ${b.addr}` }, state));
        break;
      }
      case "free": {
        state.free(ev.addr);
        steps.push(makeStep({ lines: line, desc: `free(${ev.addr})` }, state));
        break;
      }
      case "store_mem": {
        state.heapStore(ev.addr, ev.offset || 0, ev.byte & 0xff);
        steps.push(makeStep({ lines: line, desc: `হিপ @ ${ev.addr} [+${ev.offset||0}] = ${ev.byte & 0xff}` }, state));
        break;
      }
      case "print": {
        state.print(ev.text || "");
        steps.push(makeStep({ lines: line, desc: `stdout ← ${(ev.text||"").replace(/\n/g,"\\n")}` }, state));
        break;
      }
      case "note": {
        steps.push(makeStep({ lines: line, desc: ev.text || "নোট" }, state));
        break;
      }
      default: {
        steps.push(makeStep({ lines: line, desc: `অচেনা ইভেন্ট: ${ev.kind}` }, state));
      }
    }
  }

  return steps;
}

/* -------------- High-level Frontend Entrypoints --------------- */
/**
 * Detects payload flavor and dispatches to the correct parser.
 * @param {any} payload  Clang JSON (AST or events[]) or WASM events[]
 * @param {"clang"|"wasm"|"auto"} mode
 * @returns {Step[]}
 */
function parseToSteps(payload, mode = "auto") {
  if (mode === "clang") return parseClangTrace(payload);
  if (mode === "wasm") return parseWasmTrace(payload);

  // auto-detect
  if (Array.isArray(payload)) {
    // assume WASM-style events if `kind` present in first item
    if (payload[0] && typeof payload[0] === "object" && "kind" in payload[0]) {
      return parseWasmTrace(payload);
    }
    // otherwise assume clang runtime events
    return parseClangTrace(payload);
  }
  if (payload && typeof payload === "object") {
    if (payload.kind === "TranslationUnitDecl") return parseClangTrace(payload); // AST JSON
    if (Array.isArray(payload.events)) return parseClangTrace(payload);
  }
  throw new Error("Unrecognized payload format");
}

/* --------------------- Demo Utilities ------------------------- */
/**
 * Synthesize steps from a minimal C snippet outline.
 * Useful for testing the UI quickly without real traces.
 */
function synthesizeFromRecipe(recipe = {}) {
  const state = new State();
  const steps = [];

  // Start main
  state.pushFrame("main");
  steps.push(makeStep({ lines: recipe.startLine ? [recipe.startLine] : [], desc: "main শুরু" }, state));

  // Allocate a few locals
  if (recipe.locals) {
    for (const L of recipe.locals) {
      state.allocLocal(L.name, L.type || "int", L.size || 4, L.value ?? 0);
      steps.push(makeStep({ lines: L.line ? [L.line] : [], desc: `লোকাল ${L.name} বরাদ্দ` }, state));
    }
  }

  // Optional heap block
  if (recipe.heapBytes) {
    const b = state.malloc(recipe.heapBytes.length, "malloc(int[n])");
    recipe.heapBytes.forEach((bt, i) => state.heapStore(b.addr, i, bt));
    steps.push(makeStep({ desc: `হিপ বরাদ্দ @ ${b.addr}` }, state));
  }

  // Print
  if (recipe.print) {
    state.print(recipe.print);
    steps.push(makeStep({ desc: `printf → "${recipe.print.replace(/\n/g,"\\n")}"` }, state));
  }

  // End main
  steps.push(makeStep({ lines: recipe.endLine ? [recipe.endLine] : [], desc: "return 0; প্রোগ্রাম শেষ" }, state));
  return steps;
}

/* ---------------------- Public Exports ------------------------ */

const MemVizParser = {
  parseClangTrace,
  parseWasmTrace,
  parseToSteps,
  synthesizeFromRecipe,
  util: {
    toHex,
    bytesFromIntLE,
    strBytesWithNull,
    STACK_TOP,
    HEAP_BASE
  }
};

// UMD-style export
(function attach(root, api) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;         // Node / bundlers
  } else if (typeof define === "function" && define.amd) {
    define([], () => api);        // AMD
  } else {
    root.MemVizParser = api;      // Browser global
  }
})(typeof self !== "undefined" ? self : globalThis, MemVizParser);

/* ----------------------- Usage Examples -----------------------
1) Browser (with your existing UI):
   <script src="parser.js"></script>
   <script>
     const steps = MemVizParser.parseToSteps([
       { type:"function_enter", fn:"main", line:9 },
       { type:"local_alloc", name:"x", vtype:"int", size:4, value:42, line:10 },
       { type:"malloc", sizeBytes:4, sym:"p", line:11 },
       { type:"store", addr:"0x10000000", bytes:[99,0,0,0], line:12 },
       { type:"printf", text:"99\\n", line:13 },
       { type:"function_exit", fn:"main", line:14 }
     ], "clang");
     // Feed `steps` to your visualizer.
   </script>

2) WASM:
   const steps = MemVizParser.parseToSteps([
     { kind:"call", fn:"main", line:9 },
     { kind:"alloc_local", name:"n", vtype:"i32", size:4, value:3, line:10 },
     { kind:"print", text:"hello\\n", line:11 },
     { kind:"ret", fn:"main", line:12 }
   ], "wasm");

3) Quick synthetic:
   const steps = MemVizParser.synthesizeFromRecipe({
     startLine: 5,
     endLine: 12,
     locals: [{name:"x", value:42, line:6}],
     heapBytes: [1,2,3,4],
     print: "done\\n"
   });
----------------------------------------------------------------*/
