// Sandboxed execution of AI-generated animation code.
//
// Each distinct code string gets its own V8 context (node:vm) that has no
// require/process/module and no host-realm objects reachable from it:
//  - the contextified global is a null-prototype object, so `this.constructor`
//    resolves to the *sandbox* realm's Object/Function, not the host's;
//  - string code generation (eval / new Function) is disabled inside it;
//  - all data crosses the boundary as JSON strings, and results come back as a
//    JSON string serialised inside the sandbox (so getters/proxies run under the
//    timeout, never on the host);
//  - every frame runs with a hard timeout, and microtasks are drained inside it.
//
// node:vm is not a security boundary against a determined attacker with a V8
// exploit, but it does stop accidental/AI-written infinite loops from freezing
// the render loop and keeps ordinary JS from reaching the host process.

import vm from 'node:vm';
import { logRateLimited } from '../utils/rateLimitedLog.js';

const FRAME_TIMEOUT_MS = Math.max(1, Number(process.env.AI_CODE_TIMEOUT_MS) || 20);
const DISABLE_AFTER_ERROR_MS = 10_000;
const MAX_CACHED_PROGRAMS = 20;

// Bootstrap script, run once per context. Defines non-writable helpers that the
// per-frame script calls. JSON.parse/stringify and Object.freeze are captured
// before user code runs so user code cannot swap them out.
const BOOTSTRAP_SOURCE = `
(function () {
  'use strict';
  const g = globalThis;
  for (const k of ['SharedArrayBuffer', 'Atomics', 'WebAssembly']) {
    try { delete g[k]; } catch (e) {}
  }
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const freeze = Object.freeze;
  const isFrozen = Object.isFrozen;
  const keys = Object.keys;
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !isFrozen(o)) {
      freeze(o);
      const ks = keys(o);
      for (let i = 0; i < ks.length; i++) deepFreeze(o[ks[i]]);
    }
    return o;
  }
  let layout = freeze({ lights: freeze([]), walls: freeze([]), width: 0, height: 0 });
  let colorsKey = null;
  let colors = freeze([]);
  Object.defineProperty(g, '__setLayout', {
    value: function (json) { layout = deepFreeze(parse(json)); },
  });
  Object.defineProperty(g, '__run', {
    value: function (fn, inputJSON) {
      const input = parse(inputJSON);
      const colorsJSON = stringify(input.colors);
      if (colorsJSON !== colorsKey) { colors = deepFreeze(input.colors); colorsKey = colorsJSON; }
      const ctx = freeze({
        frame: input.frame,
        colors: colors,
        scope: input.scope,
        lights: layout.lights,
        walls: layout.walls,
        width: layout.width,
        height: layout.height,
      });
      const r = fn(ctx);
      if (!r || typeof r !== 'object') return null;
      return stringify(r);
    },
  });
})();
`;

const bootstrapScript = new vm.Script(BOOTSTRAP_SOURCE, { filename: 'ai-bootstrap.js' });
const setLayoutScript = new vm.Script('__setLayout(__layout)', { filename: 'ai-layout.js' });
const frameScript = new vm.Script('__run(__fn, __input)', { filename: 'ai-frame.js' });

function wrapUserCode(code: string): string {
  // Defined as a non-writable global so the frame script always calls the
  // compiled function. Newlines keep user line numbers roughly meaningful.
  return `Object.defineProperty(globalThis, '__fn', { value: (function (ctx) {\n${code}\n}) });`;
}

/** Syntax-check AI code without running it. */
export function compileAICode(code: string): { ok: true } | { ok: false; error: string } {
  try {
    new vm.Script(wrapUserCode(code), { filename: 'ai-effect.js' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface AILayout {
  lights: Array<{ id: number; x: number; y: number; wallIndex: number; cx: number }>;
  walls: Array<{ name: string; width: number; height: number; groupId: string | null }>;
  width: number;
  height: number;
}

interface Program {
  context: vm.Context | null;
  sandbox: Record<string, unknown>;
  layoutVersion: number;
  disabledUntil: number;
  compileError: string | null;
}

function defineSlot(sandbox: Record<string, unknown>, name: string, value: unknown): void {
  // Non-configurable data property: sandbox code cannot replace it with a
  // getter/setter, so host-side writes never execute sandbox code.
  Object.defineProperty(sandbox, name, { value, writable: true, enumerable: false, configurable: false });
}

export class AICodeRunner {
  private programs: Map<string, Program> = new Map();
  private layoutJSON = JSON.stringify({ lights: [], walls: [], width: 0, height: 0 });
  private layoutVersion = 0;

  setLayout(layout: AILayout): void {
    this.layoutJSON = JSON.stringify(layout);
    this.layoutVersion++;
  }

  clear(): void {
    this.programs.clear();
  }

  private getProgram(code: string): Program {
    const existing = this.programs.get(code);
    if (existing) {
      // LRU: move to the most-recent end
      this.programs.delete(code);
      this.programs.set(code, existing);
      return existing;
    }

    const sandbox: Record<string, unknown> = Object.create(null);
    defineSlot(sandbox, '__input', '');
    defineSlot(sandbox, '__layout', '');
    const program: Program = { context: null, sandbox, layoutVersion: -1, disabledUntil: 0, compileError: null };

    try {
      const context = vm.createContext(sandbox, {
        name: 'ai-effect',
        codeGeneration: { strings: false, wasm: false },
        microtaskMode: 'afterEvaluate',
      });
      bootstrapScript.runInContext(context, { timeout: 100 });
      new vm.Script(wrapUserCode(code), { filename: 'ai-effect.js' }).runInContext(context, { timeout: 100 });
      program.context = context;
    } catch (err) {
      program.compileError = err instanceof Error ? err.message : String(err);
      logRateLimited(`AI code compile error: ${program.compileError}`);
    }

    this.programs.set(code, program);
    while (this.programs.size > MAX_CACHED_PROGRAMS) {
      const oldest = this.programs.keys().next().value as string;
      this.programs.delete(oldest);
    }
    return program;
  }

  /**
   * Run one frame. Returns the parsed {lightId: color} object, or null when the
   * code failed, timed out, is temporarily disabled, or returned nothing.
   */
  run(code: string, frame: number, colors: unknown[], scope: string): Record<string, unknown> | null {
    const program = this.getProgram(code);
    if (!program.context) return null;

    const now = Date.now();
    if (program.disabledUntil > now) return null;

    try {
      if (program.layoutVersion !== this.layoutVersion) {
        program.sandbox.__layout = this.layoutJSON;
        setLayoutScript.runInContext(program.context, { timeout: 100 });
        program.layoutVersion = this.layoutVersion;
      }

      program.sandbox.__input = JSON.stringify({ frame, colors, scope });
      const out = frameScript.runInContext(program.context, { timeout: FRAME_TIMEOUT_MS });
      if (typeof out !== 'string') return null;
      const parsed: unknown = JSON.parse(out);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const timedOut = /timed out/i.test(msg);
      program.disabledUntil = now + DISABLE_AFTER_ERROR_MS;
      logRateLimited(
        `AI code ${timedOut ? `exceeded ${FRAME_TIMEOUT_MS}ms frame budget` : `threw: ${msg}`}; ` +
        `disabled for ${DISABLE_AFTER_ERROR_MS / 1000}s`
      );
      return null;
    }
  }
}
