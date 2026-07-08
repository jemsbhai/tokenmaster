/**
 * Handoff fidelity protocol (contract section 6). Port of
 * python/tokenmaster/src/tokenmaster/fidelity.py.
 *
 * "Was that continuation prompt any good" becomes measurable: derive probe
 * question-answer pairs from the source context, answer them with only the
 * handoff artifact in view, score answerable/correct, and report a weighted
 * fidelity in [0, 1] overall and per category.
 *
 * The core owns the data structures and orchestration only. Every LLM
 * touchpoint is an adapter behind a small interface (ProbeGenerator,
 * Answerer, Judge), so the protocol runs fully offline with user-supplied
 * probes and a scripted answerer. Reports carry method, adapter identities,
 * and the seed, so a result is reproducible, plus explicit caveats about
 * what version 0.1 does naively (answerability is judged by non-empty
 * response; the built-in judge is lenient normalized containment).
 */

import { SCHEMA_VERSION } from "./types.js";

// ---------------------------------------------------------------------------
// coercion helpers

function asInt(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  return Math.trunc(n);
}

function asFloat(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  return n;
}

function reqString(value: unknown, field: string): string {
  if (value === null || value === undefined) {
    throw new TypeError(`${field} is required`);
  }
  return String(value);
}

function optString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

// ---------------------------------------------------------------------------
// probe data model

export const ProbeCategory = {
  OBJECTIVE: "objective",
  DECISIONS: "decisions",
  CONSTRAINTS: "constraints",
  STATE: "state",
  ARTIFACTS: "artifacts",
} as const;
export type ProbeCategory = (typeof ProbeCategory)[keyof typeof ProbeCategory];

const PROBE_CATEGORY_VALUES = new Set<string>(Object.values(ProbeCategory));

export function asProbeCategory(value: unknown): ProbeCategory {
  if (typeof value === "string" && PROBE_CATEGORY_VALUES.has(value)) {
    return value as ProbeCategory;
  }
  throw new RangeError(`'${String(value)}' is not a valid ProbeCategory`);
}

export interface ProbeDict {
  id: string;
  category: ProbeCategory;
  question: string;
  gold_answer: string;
  weight: number;
}

/** One question with its gold answer, derived from the source context. */
export class Probe {
  readonly id: string;
  readonly category: ProbeCategory;
  readonly question: string;
  readonly gold_answer: string;
  readonly weight: number;

  constructor(fields: {
    id: string;
    category: ProbeCategory;
    question: string;
    gold_answer: string;
    weight?: number;
  }) {
    this.id = fields.id;
    this.category = fields.category;
    this.question = fields.question;
    this.gold_answer = fields.gold_answer;
    this.weight = fields.weight ?? 1.0;
    if (this.weight <= 0) {
      throw new RangeError("probe weight must be positive");
    }
    Object.freeze(this);
  }

  toDict(): ProbeDict {
    return {
      id: this.id,
      category: this.category,
      question: this.question,
      gold_answer: this.gold_answer,
      weight: this.weight,
    };
  }

  toJSON(): ProbeDict {
    return this.toDict();
  }

  static fromDict(dict: object): Probe {
    const d = dict as Record<string, unknown>;
    return new Probe({
      id: reqString(d["id"], "id"),
      category: asProbeCategory(d["category"]),
      question: reqString(d["question"], "question"),
      gold_answer: reqString(d["gold_answer"], "gold_answer"),
      weight: d["weight"] === null || d["weight"] === undefined
        ? 1.0
        : asFloat(d["weight"], "weight"),
    });
  }
}

export interface ProbeOutcomeDict {
  probe: ProbeDict;
  answer: string | null;
  answerable: boolean;
  correct: boolean;
  judge_note: string | null;
}

export class ProbeOutcome {
  readonly probe: Probe;
  readonly answer: string | null;
  readonly answerable: boolean;
  readonly correct: boolean;
  readonly judge_note: string | null;

  constructor(fields: {
    probe: Probe;
    answer: string | null;
    answerable: boolean;
    correct: boolean;
    judge_note?: string | null;
  }) {
    this.probe = fields.probe;
    this.answer = fields.answer;
    this.answerable = fields.answerable;
    this.correct = fields.correct;
    this.judge_note = fields.judge_note ?? null;
    Object.freeze(this);
  }

  toDict(): ProbeOutcomeDict {
    return {
      probe: this.probe.toDict(),
      answer: this.answer,
      answerable: this.answerable,
      correct: this.correct,
      judge_note: this.judge_note,
    };
  }

  toJSON(): ProbeOutcomeDict {
    return this.toDict();
  }

  static fromDict(dict: object): ProbeOutcome {
    const d = dict as Record<string, unknown>;
    return new ProbeOutcome({
      probe: Probe.fromDict(d["probe"] as Record<string, unknown>),
      answer: optString(d["answer"]),
      answerable: Boolean(d["answerable"]),
      correct: Boolean(d["correct"]),
      judge_note: optString(d["judge_note"]),
    });
  }
}

export interface FidelityReportDict {
  score: number;
  per_category: Record<string, number>;
  outcomes: ProbeOutcomeDict[];
  method: string;
  generator: string | null;
  answerer: string | null;
  judge: string | null;
  seed: number | null;
  caveats: string[];
  schema_version: string;
}

/** Outcome of one handoff evaluation. score is a weighted mean in [0, 1]. */
export class FidelityReport {
  readonly score: number;
  readonly per_category: Record<string, number>;
  readonly outcomes: readonly ProbeOutcome[];
  readonly method: string;
  readonly generator: string | null;
  readonly answerer: string | null;
  readonly judge: string | null;
  readonly seed: number | null;
  readonly caveats: readonly string[];
  readonly schema_version: string;

  constructor(fields: {
    score: number;
    per_category: Record<string, number>;
    outcomes: readonly ProbeOutcome[];
    method: string;
    generator: string | null;
    answerer: string | null;
    judge: string | null;
    seed: number | null;
    caveats?: readonly string[];
    schema_version?: string;
  }) {
    this.score = fields.score;
    this.per_category = fields.per_category;
    this.outcomes = [...fields.outcomes];
    this.method = fields.method;
    this.generator = fields.generator;
    this.answerer = fields.answerer;
    this.judge = fields.judge;
    this.seed = fields.seed;
    this.caveats = [...(fields.caveats ?? [])];
    this.schema_version = fields.schema_version ?? SCHEMA_VERSION;
    Object.freeze(this);
  }

  toDict(): FidelityReportDict {
    return {
      score: this.score,
      per_category: { ...this.per_category },
      outcomes: this.outcomes.map((o) => o.toDict()),
      method: this.method,
      generator: this.generator,
      answerer: this.answerer,
      judge: this.judge,
      seed: this.seed,
      caveats: [...this.caveats],
      schema_version: this.schema_version,
    };
  }

  toJSON(): FidelityReportDict {
    return this.toDict();
  }

  static fromDict(dict: object): FidelityReport {
    const d = dict as Record<string, unknown>;
    return new FidelityReport({
      score: asFloat(d["score"], "score"),
      per_category: {
        ...((d["per_category"] as Record<string, number>) ?? {}),
      },
      outcomes: ((d["outcomes"] as Record<string, unknown>[]) ?? []).map(
        (o) => ProbeOutcome.fromDict(o)
      ),
      method: reqString(d["method"], "method"),
      generator: optString(d["generator"]),
      answerer: optString(d["answerer"]),
      judge: optString(d["judge"]),
      seed:
        d["seed"] === null || d["seed"] === undefined
          ? null
          : asInt(d["seed"], "seed"),
      caveats: [...((d["caveats"] as string[]) ?? [])],
      schema_version:
        d["schema_version"] === null || d["schema_version"] === undefined
          ? SCHEMA_VERSION
          : String(d["schema_version"]),
    });
  }
}

// ---------------------------------------------------------------------------
// adapter interfaces (every LLM touchpoint lives behind one of these)

export interface ProbeGenerator {
  name: string;
  generate(
    sourceContext: string,
    n: number,
    seed?: number | null
  ): readonly Probe[];
}

export interface Answerer {
  name: string;
  answer(handoffArtifact: string, question: string): string;
}

export interface Judge {
  name: string;
  judge(
    question: string,
    goldAnswer: string,
    answer: string
  ): [boolean, string | null];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Lenient normalized containment: correct when the normalized gold answer
 * appears within the normalized answer. Deterministic and offline; a
 * semantic judge is an adapter concern.
 */
export class ExactMatchJudge implements Judge {
  readonly name = "exact-match";

  judge(
    question: string,
    goldAnswer: string,
    answer: string
  ): [boolean, string | null] {
    return [normalize(answer).includes(normalize(goldAnswer)), null];
  }
}

// ---------------------------------------------------------------------------
// orchestration

function weightedScore(outcomes: readonly ProbeOutcome[]): number {
  let total = 0.0;
  for (const outcome of outcomes) {
    total += outcome.probe.weight;
  }
  if (total <= 0) {
    throw new RangeError("no probe weight to score");
  }
  let correctTotal = 0.0;
  for (const outcome of outcomes) {
    if (outcome.correct) {
      correctTotal += outcome.probe.weight;
    }
  }
  return correctTotal / total;
}

function adapterName(adapter: object): string {
  const name = (adapter as { name?: unknown }).name;
  return typeof name === "string" ? name : adapter.constructor.name;
}

/**
 * Run the probe-QA protocol against a handoff artifact.
 *
 * Supply pre-built probes (fully offline) or a source_context plus a
 * probe_generator. The judge defaults to ExactMatchJudge.
 */
export function evaluateHandoff(
  handoffArtifact: string,
  options: {
    answerer: Answerer;
    probes?: readonly Probe[] | null;
    source_context?: string | null;
    probe_generator?: ProbeGenerator | null;
    judge?: Judge | null;
    n?: number;
    seed?: number | null;
    method?: string;
  }
): FidelityReport {
  const generator = options.probe_generator ?? null;
  const sourceContext = options.source_context ?? null;
  const n = options.n ?? 10;
  const seed = options.seed ?? null;
  const method = options.method ?? "probe-qa-0.1";

  let probes = options.probes ?? null;
  if (probes === null) {
    if (generator === null || sourceContext === null) {
      throw new RangeError(
        "supply probes, or source_context with a probe_generator"
      );
    }
    probes = [...generator.generate(sourceContext, n, seed)];
  }
  if (probes.length === 0) {
    throw new RangeError("no probes to evaluate");
  }

  const chosenJudge: Judge = options.judge ?? new ExactMatchJudge();

  const outcomes: ProbeOutcome[] = [];
  for (const probe of probes) {
    const answer = options.answerer.answer(handoffArtifact, probe.question);
    const answerable = Boolean(answer && answer.trim());
    let correct = false;
    let note: string | null = null;
    if (answerable) {
      [correct, note] = chosenJudge.judge(
        probe.question,
        probe.gold_answer,
        answer
      );
    }
    outcomes.push(
      new ProbeOutcome({
        probe,
        answer: answerable ? answer : null,
        answerable,
        correct,
        judge_note: note,
      })
    );
  }

  const perCategory: Record<string, number> = {};
  const categories = new Set<ProbeCategory>();
  for (const outcome of outcomes) {
    categories.add(outcome.probe.category);
  }
  for (const category of categories) {
    const members = outcomes.filter((o) => o.probe.category === category);
    perCategory[category] = weightedScore(members);
  }

  const caveats: string[] = [
    "answerability judged by non-empty response only (0.1)",
  ];
  if (chosenJudge instanceof ExactMatchJudge) {
    caveats.push("exact-match judging is lenient normalized containment");
  }

  return new FidelityReport({
    score: weightedScore(outcomes),
    per_category: perCategory,
    outcomes,
    method,
    generator: generator !== null ? adapterName(generator) : null,
    answerer: adapterName(options.answerer),
    judge: adapterName(chosenJudge),
    seed,
    caveats,
  });
}
