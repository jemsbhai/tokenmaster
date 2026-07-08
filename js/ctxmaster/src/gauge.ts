/**
 * The context gauge: hero surface of ctxmaster (contract decision D10).
 *
 * Renders a tokenmaster MeterState as a terminal panel: a zone-colored fill
 * bar against the effective window with threshold ticks, and ancillary rows
 * for context accounting, velocity, ETA, zone, and the optional extras
 * (reserved output, hidden overhead, cache prefix). Every number displayed
 * comes straight from MeterState; the gauge computes nothing itself.
 *
 * Zero dependencies by design (ruling A): colors and the live in-place
 * redraw are raw ANSI escape sequences. Color support is detected from
 * NO_COLOR, FORCE_COLOR, TERM=dumb, and TTY state when writing to the
 * default stream; a custom write sink defaults to plain text unless colors
 * are requested explicitly. The palette approximates the Python wrapper's
 * rich styles (green, yellow3, red3, grey37) in 256-color ANSI.
 *
 * Note on threshold ticks: MeterState (schema 0.1) does not carry the zone
 * thresholds, so the gauge takes them as display parameters defaulting to
 * the contract values (caution 0.70, critical 0.85). A Meter configured
 * with custom thresholds should be paired with a gauge constructed to
 * match. Promoting thresholds into MeterState is a schema 0.2 candidate.
 */

import { Meter, MeterState, TurnRecorded, Zone } from "tokenmaster";

declare const process:
  | {
      env: Record<string, string | undefined>;
      stdout?: { isTTY?: boolean; write(text: string): unknown };
    }
  | undefined;

// ---------------------------------------------------------------------------
// ANSI machinery

const RESET = "\u001b[0m";
const DIM = "2";
const BOLD = "1";

/** SGR color codes per zone, approximating the rich palette. */
export const ZONE_STYLE: Record<Zone, string> = {
  [Zone.GREEN]: "32",
  [Zone.CAUTION]: "38;5;184",
  [Zone.CRITICAL]: "38;5;160",
};

const GREY = "38;5;59";

const FILLED = "\u2588"; // full block
const EMPTY = "\u2591"; // light shade
const TICK = "\u2502"; // vertical line

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function detectColors(): boolean {
  if (typeof process === "undefined" || process === undefined) {
    return false;
  }
  const env = process.env;
  if ("NO_COLOR" in env) {
    return false;
  }
  if (env["FORCE_COLOR"] !== undefined && env["FORCE_COLOR"] !== "0") {
    return true;
  }
  if (env["TERM"] === "dumb") {
    return false;
  }
  return Boolean(process.stdout && process.stdout.isTTY);
}

function defaultWrite(): (text: string) => void {
  const stdout =
    typeof process !== "undefined" && process !== undefined
      ? process.stdout
      : undefined;
  if (stdout !== undefined) {
    return (text: string) => {
      stdout.write(text);
    };
  }
  return () => {
    throw new Error(
      "no default output stream in this environment; pass a write option"
    );
  };
}

// ---------------------------------------------------------------------------
// number formatting mirroring the Python wrapper's display strings

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Python "{:,}" on integers. */
function commas(n: number): string {
  const negative = n < 0;
  const body = groupDigits(Math.trunc(Math.abs(n)).toString());
  return (negative ? "-" : "") + body;
}

/** Python "{:,.0f}". */
function commas0(x: number): string {
  return commas(Math.round(x));
}

/** Python "{:,.1f}". */
function commas1(x: number): string {
  const fixed = Math.abs(x).toFixed(1);
  const dot = fixed.indexOf(".");
  const body = groupDigits(fixed.slice(0, dot)) + fixed.slice(dot);
  return (x < 0 ? "-" : "") + body;
}

/** Python "{:6.1%}". */
function percent6(fraction: number): string {
  return ((fraction * 100).toFixed(1) + "%").padStart(6);
}

// ---------------------------------------------------------------------------
// panel box characters (rich's rounded box)

const TOP_LEFT = "\u256d";
const TOP_RIGHT = "\u256e";
const BOTTOM_LEFT = "\u2570";
const BOTTOM_RIGHT = "\u256f";
const HORIZONTAL = "\u2500";
const VERTICAL = "\u2502";

export interface GaugeOptions {
  /** Output sink; defaults to process.stdout. */
  write?: (text: string) => void;
  /**
   * Emit ANSI colors. Defaults to environment detection for the default
   * stream, and to false when a custom write sink is supplied.
   */
  colors?: boolean;
  bar_width?: number;
  caution?: number;
  critical?: number;
}

/** Handle returned by live(); stop() detaches. Supports `using` on Node 24+. */
export interface LiveGauge {
  stop(): void;
}

/** Terminal renderer for MeterState. */
export class ContextGauge {
  readonly bar_width: number;
  readonly caution: number;
  readonly critical: number;

  private readonly _write: (text: string) => void;
  private readonly _colors: boolean;

  constructor(options: GaugeOptions = {}) {
    const barWidth = options.bar_width ?? 50;
    if (barWidth < 5) {
      throw new RangeError("bar_width must be at least 5");
    }
    this.bar_width = barWidth;
    this.caution = options.caution ?? 0.7;
    this.critical = options.critical ?? 0.85;
    this._write = options.write ?? defaultWrite();
    this._colors =
      options.colors ?? (options.write !== undefined ? false : detectColors());
  }

  // ------------------------------------------------------------------ //
  // rendering (pure)

  private _paint(text: string, code: string): string {
    return this._colors ? `\u001b[${code}m${text}${RESET}` : text;
  }

  /** Render the full panel for a state; returns a string, ANSI included
   * when colors are enabled. */
  render(state: MeterState): string {
    const zoneCode = ZONE_STYLE[state.zone];
    const contentLines = [this._barLine(state), ...this._infoRows(state)];
    const title = `ctxmaster \u00b7 ${state.model_id}`;
    const subtitle = `turn ${state.turns}`;

    let width = Math.max(title.length, subtitle.length);
    for (const line of contentLines) {
      width = Math.max(width, stripAnsi(line).length);
    }
    const inner = width + 2; // padding (0, 1)

    const top = this._borderLine(TOP_LEFT, TOP_RIGHT, title, inner, zoneCode);
    const bottom = this._borderLine(
      BOTTOM_LEFT,
      BOTTOM_RIGHT,
      subtitle,
      inner,
      zoneCode
    );
    const side = this._paint(VERTICAL, zoneCode);
    const rows = contentLines.map((line) => {
      const pad = " ".repeat(width - stripAnsi(line).length);
      return `${side} ${line}${pad} ${side}`;
    });
    return [top, ...rows, bottom].join("\n");
  }

  private _borderLine(
    left: string,
    right: string,
    label: string,
    inner: number,
    code: string
  ): string {
    const text = ` ${label} `;
    const dashes = Math.max(0, inner - text.length);
    const leftDashes = Math.floor(dashes / 2);
    const rightDashes = dashes - leftDashes;
    return (
      this._paint(left + HORIZONTAL.repeat(leftDashes), code) +
      text +
      this._paint(HORIZONTAL.repeat(rightDashes) + right, code)
    );
  }

  private _barLine(state: MeterState): string {
    const width = this.bar_width;
    const fill = Math.min(Math.max(state.fill_effective, 0.0), 1.0);
    const filled = Math.round(fill * width);
    const ticks = new Set([
      Math.min(width - 1, Math.round(this.caution * width)),
      Math.min(width - 1, Math.round(this.critical * width)),
    ]);

    // group consecutive same-style cells so the ANSI output stays compact
    const segments: { text: string; code: string }[] = [];
    const push = (ch: string, code: string) => {
      const last = segments[segments.length - 1];
      if (last !== undefined && last.code === code) {
        last.text += ch;
      } else {
        segments.push({ text: ch, code });
      }
    };
    for (let i = 0; i < width; i++) {
      if (i < filled) {
        push(FILLED, ZONE_STYLE[state.zone]);
      } else if (ticks.has(i)) {
        push(TICK, DIM);
      } else {
        push(EMPTY, GREY);
      }
    }
    const bar = segments
      .map((segment) => this._paint(segment.text, segment.code))
      .join("");
    return bar + this._paint(` ${percent6(state.fill_effective)}`, BOLD);
  }

  private _infoRows(state: MeterState): string[] {
    const rows: [string, string][] = [];

    const used = `${commas(state.used_tokens)} / ${commas(state.window_effective)} effective`;
    const nominal = `(${commas(state.window_nominal)} nominal)`;
    rows.push(["context", `${used} ${nominal}`]);
    rows.push(["capacity", state.effective_source]);

    if (state.velocity !== null && state.velocity_std !== null) {
      rows.push([
        "velocity",
        `${commas0(state.velocity)} \u00b1 ${commas0(state.velocity_std)} tok/turn`,
      ]);
    } else {
      rows.push([
        "velocity",
        state.provenance["velocity"] ?? "unavailable",
      ]);
    }

    if (state.eta_turns !== null) {
      rows.push([
        "eta",
        `${commas1(state.eta_turns.expected)} turns ` +
          `(${commas1(state.eta_turns.conservative)} conservative)`,
      ]);
    } else {
      rows.push(["eta", state.provenance["eta_turns"] ?? "unavailable"]);
    }

    rows.push([
      "zone",
      this._paint(state.zone.toUpperCase(), `${BOLD};${ZONE_STYLE[state.zone]}`),
    ]);

    if (state.reserved_output) {
      rows.push(["reserved", `${commas(state.reserved_output)} tok output`]);
    }
    if (state.hidden_overhead !== null) {
      rows.push([
        "overhead",
        `${commas(state.hidden_overhead)} tok (system prompt + tool schemas)`,
      ]);
    }
    if (state.cache !== null) {
      rows.push([
        "cache",
        `~${commas(state.cache.stable_prefix_tokens)} tok stable prefix`,
      ]);
    }

    const labelWidth = Math.max(...rows.map(([label]) => label.length));
    return rows.map(
      ([label, value]) =>
        this._paint(label.padEnd(labelWidth), DIM) + "  " + value
    );
  }

  // ------------------------------------------------------------------ //
  // output

  print(state: MeterState): void {
    this._write(this.render(state) + "\n");
  }

  /** Print a fresh gauge on every recorded turn; returns an unsubscriber. */
  attach(meter: Meter): () => void {
    return meter.subscribe((event) => {
      if (event instanceof TurnRecorded) {
        this.print(event.state);
      }
    });
  }

  /**
   * In-place updating gauge bound to a meter, for interactive use.
   *
   * Draws immediately, redraws on every recorded turn by cursor-repositioning
   * over the previous frame (intended for TTY output), and detaches on
   * stop(). The handle also carries Symbol.dispose where the runtime
   * supports it, so `using gauge = ...` works on Node 24 and later.
   */
  live(meter: Meter): LiveGauge {
    let height = 0;
    const draw = (state: MeterState) => {
      let out = "";
      if (height > 0) {
        out += `\u001b[${height}A\u001b[0J`;
      }
      const rendered = this.render(state);
      height = rendered.split("\n").length;
      this._write(out + rendered + "\n");
    };
    draw(meter.state());
    const unsubscribe = meter.subscribe((event) => {
      if (event instanceof TurnRecorded) {
        draw(event.state);
      }
    });
    let stopped = false;
    const stop = () => {
      if (!stopped) {
        stopped = true;
        unsubscribe();
      }
    };
    const handle: LiveGauge = { stop };
    const disposeSymbol = (Symbol as { dispose?: symbol }).dispose;
    if (disposeSymbol !== undefined) {
      (handle as unknown as Record<PropertyKey, unknown>)[disposeSymbol] =
        stop;
    }
    return handle;
  }
}
