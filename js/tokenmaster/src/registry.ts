/**
 * Bundled model registry: capacities and dated pricing, offline by design.
 *
 * The snapshot is embedded at build time from the canonical
 * python/tokenmaster/src/tokenmaster/data/models.json (contract P6: nothing
 * phones home; refresh mechanisms will be explicit adapters). Embedding
 * keeps the package free of filesystem access, so the core runs in browsers
 * and bundlers unchanged. Lookup accepts canonical ids
 * ("anthropic:claude-sonnet-4-6"), bare names ("claude-sonnet-4-6"),
 * registered aliases, and dated snapshot suffixes
 * ("claude-haiku-4-5-20251001", "openai:gpt-5.5-2026-04-14").
 * User-registered profiles override bundled ones.
 *
 * Close-match suggestions port difflib.get_close_matches faithfully
 * (Ratcliff/Obershelp ratio via the same greedy longest-match recursion,
 * cutoff 0.6, top 3), so both languages suggest the same corrections. The
 * junk and autojunk heuristics never engage below 200 characters and are
 * omitted.
 */

import { ModelProfile } from "./types.js";
import { MODELS_DATA } from "./models-data.js";

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** True for version/date tails like "20251001" or "2026-04-14". */
function isDatedSuffix(s: string): boolean {
  return s.length >= 4 && /[0-9]/.test(s) && /^[0-9.\-]+$/.test(s);
}

// ---------------------------------------------------------------------------
// difflib.get_close_matches port

/**
 * Sum of matching-block sizes exactly as CPython's SequenceMatcher computes
 * them: divide and conquer around the greedy longest match, earliest match
 * winning ties.
 */
function matchTotal(a: string, b: string): number {
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const ch = b[j];
    const list = b2j.get(ch);
    if (list === undefined) {
      b2j.set(ch, [j]);
    } else {
      list.push(j);
    }
  }

  function findLongest(
    alo: number,
    ahi: number,
    blo: number,
    bhi: number
  ): [number, number, number] {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newJ2len = new Map<number, number>();
      const indices = b2j.get(a[i]);
      if (indices !== undefined) {
        for (const j of indices) {
          if (j < blo) {
            continue;
          }
          if (j >= bhi) {
            break;
          }
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newJ2len.set(j, k);
          if (k > bestsize) {
            besti = i - k + 1;
            bestj = j - k + 1;
            bestsize = k;
          }
        }
      }
      j2len = newJ2len;
    }
    return [besti, bestj, bestsize];
  }

  let total = 0;
  const queue: [number, number, number, number][] = [
    [0, a.length, 0, b.length],
  ];
  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = findLongest(alo, ahi, blo, bhi);
    if (k > 0) {
      total += k;
      if (alo < i && blo < j) {
        queue.push([alo, i, blo, j]);
      }
      if (i + k < ahi && j + k < bhi) {
        queue.push([i + k, ahi, j + k, bhi]);
      }
    }
  }
  return total;
}

function ratio(a: string, b: string): number {
  const length = a.length + b.length;
  if (length === 0) {
    return 1.0;
  }
  return (2.0 * matchTotal(a, b)) / length;
}

function getCloseMatches(
  word: string,
  possibilities: Iterable<string>,
  n = 3,
  cutoff = 0.6
): string[] {
  const scored: { score: number; value: string }[] = [];
  for (const candidate of possibilities) {
    // a = candidate, b = word, matching difflib's sequence assignment.
    const r = ratio(candidate, word);
    if (r >= cutoff) {
      scored.push({ score: r, value: candidate });
    }
  }
  // heapq.nlargest on (score, value) pairs: score descending, then value
  // descending for ties.
  scored.sort((p, q) =>
    q.score !== p.score
      ? q.score - p.score
      : q.value < p.value
        ? -1
        : q.value > p.value
          ? 1
          : 0
  );
  return scored.slice(0, n).map((entry) => entry.value);
}

// ---------------------------------------------------------------------------
// errors

/** Thrown when a model id cannot be resolved by the registry. */
export class UnknownModelError extends Error {
  readonly model_id: string;
  readonly suggestions: readonly string[];

  constructor(modelId: string, suggestions: string[]) {
    const hint =
      suggestions.length > 0
        ? " Close matches: " + suggestions.join(", ")
        : "";
    super(
      `Unknown model '${modelId}'; not in the registry.` +
        hint +
        " Register it with Registry.register(ModelProfile(...))."
    );
    this.name = "UnknownModelError";
    this.model_id = modelId;
    this.suggestions = suggestions;
  }
}

// ---------------------------------------------------------------------------
// registry

/** Model profiles keyed by canonical id, with alias resolution. */
export class Registry {
  readonly snapshot_date: string | null;
  private readonly _profiles = new Map<string, ModelProfile>();
  private readonly _alias = new Map<string, string>();

  constructor(snapshotDate: string | null = null) {
    this.snapshot_date = snapshotDate;
  }

  // ------------------------------------------------------------------ //
  // construction

  /** Add or override a profile. Later registrations win. */
  register(
    profile: ModelProfile,
    aliases: Iterable<string> = []
  ): ModelProfile {
    const canonical = norm(profile.model_id);
    this._profiles.set(canonical, profile);
    this._alias.set(canonical, canonical);
    if (canonical.includes(":")) {
      const bare = canonical.slice(canonical.indexOf(":") + 1);
      if (!this._alias.has(bare)) {
        this._alias.set(bare, canonical);
      }
    }
    for (const alias of aliases) {
      const a = norm(alias);
      this._alias.set(a, canonical);
      if (!a.includes(":")) {
        const qualified = `${profile.provider}:${a}`;
        if (!this._alias.has(qualified)) {
          this._alias.set(qualified, canonical);
        }
      }
    }
    return profile;
  }

  static fromDict(dict: object): Registry {
    const d = dict as Record<string, unknown>;
    const reg = new Registry((d["snapshot_date"] ?? null) as string | null);
    const models = (d["models"] ?? []) as Record<string, unknown>[];
    for (const entry of models) {
      const copy: Record<string, unknown> = { ...entry };
      const aliases = (copy["aliases"] ?? []) as string[];
      delete copy["aliases"];
      reg.register(ModelProfile.fromDict(copy), aliases);
    }
    return reg;
  }

  /** A fresh registry from the embedded snapshot. */
  static bundled(): Registry {
    return Registry.fromDict(MODELS_DATA as Record<string, unknown>);
  }

  // ------------------------------------------------------------------ //
  // lookup

  get(modelId: string): ModelProfile {
    const key = norm(modelId);
    const hit = this._alias.get(key);
    if (hit !== undefined) {
      return this._profiles.get(hit)!;
    }

    // dated snapshot suffixes: longest known base wins
    let best: string | null = null;
    for (const base of this._alias.keys()) {
      if (
        key.startsWith(base + "-") &&
        isDatedSuffix(key.slice(base.length + 1))
      ) {
        if (best === null || base.length > best.length) {
          best = base;
        }
      }
    }
    if (best !== null) {
      return this._profiles.get(this._alias.get(best)!)!;
    }

    const suggestions = getCloseMatches(key, this._alias.keys());
    throw new UnknownModelError(modelId, suggestions);
  }

  /** Whether the id resolves (Python: `model_id in registry`). */
  has(modelId: string): boolean {
    try {
      this.get(modelId);
      return true;
    } catch (error) {
      if (error instanceof UnknownModelError) {
        return false;
      }
      throw error;
    }
  }

  get ids(): readonly string[] {
    return [...this._profiles.keys()].sort();
  }

  get profiles(): readonly ModelProfile[] {
    return [...this._profiles.keys()]
      .sort()
      .map((key) => this._profiles.get(key)!);
  }
}

// ---------------------------------------------------------------------------
// process-wide default

let _default: Registry | null = null;

/** The bundled registry, loaded once per process. */
export function defaultRegistry(): Registry {
  if (_default === null) {
    _default = Registry.bundled();
  }
  return _default;
}

/** Resolve against the default registry. */
export function getProfile(modelId: string): ModelProfile {
  return defaultRegistry().get(modelId);
}
