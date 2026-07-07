"""Handoff fidelity protocol (contract section 6).

"Was that continuation prompt any good" becomes measurable: derive probe
question-answer pairs from the source context, answer them with only the
handoff artifact in view, score answerable/correct, and report a weighted
fidelity in [0, 1] overall and per category.

The core owns the data structures and orchestration only. Every LLM
touchpoint is an adapter behind a small protocol (ProbeGenerator, Answerer,
Judge), so the protocol runs fully offline with user-supplied probes and a
scripted answerer. Reports carry method, adapter identities, and the seed,
so a result is reproducible, plus explicit caveats about what version 0.1
does naively (answerability is judged by non-empty response; the built-in
judge is lenient normalized containment).
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Mapping, Protocol, Sequence

from .types import SCHEMA_VERSION


class ProbeCategory(str, Enum):
    OBJECTIVE = "objective"
    DECISIONS = "decisions"
    CONSTRAINTS = "constraints"
    STATE = "state"
    ARTIFACTS = "artifacts"


@dataclass(frozen=True)
class Probe:
    """One question with its gold answer, derived from the source context."""

    id: str
    category: ProbeCategory
    question: str
    gold_answer: str
    weight: float = 1.0

    def __post_init__(self) -> None:
        if self.weight <= 0:
            raise ValueError("probe weight must be positive")

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["category"] = self.category.value
        return d

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Probe":
        return cls(
            id=str(d["id"]),
            category=ProbeCategory(d["category"]),
            question=str(d["question"]),
            gold_answer=str(d["gold_answer"]),
            weight=float(d.get("weight", 1.0)),
        )


@dataclass(frozen=True)
class ProbeOutcome:
    probe: Probe
    answer: str | None
    answerable: bool
    correct: bool
    judge_note: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "probe": self.probe.to_dict(),
            "answer": self.answer,
            "answerable": self.answerable,
            "correct": self.correct,
            "judge_note": self.judge_note,
        }

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "ProbeOutcome":
        return cls(
            probe=Probe.from_dict(d["probe"]),
            answer=d.get("answer"),
            answerable=bool(d["answerable"]),
            correct=bool(d["correct"]),
            judge_note=d.get("judge_note"),
        )


@dataclass(frozen=True)
class FidelityReport:
    """Outcome of one handoff evaluation. score is weighted mean in [0, 1]."""

    score: float
    per_category: dict[str, float]
    outcomes: tuple[ProbeOutcome, ...]
    method: str
    generator: str | None
    answerer: str | None
    judge: str | None
    seed: int | None
    caveats: tuple[str, ...] = ()
    schema_version: str = SCHEMA_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "per_category": dict(self.per_category),
            "outcomes": [o.to_dict() for o in self.outcomes],
            "method": self.method,
            "generator": self.generator,
            "answerer": self.answerer,
            "judge": self.judge,
            "seed": self.seed,
            "caveats": list(self.caveats),
            "schema_version": self.schema_version,
        }

    def to_json(self, **kwargs: Any) -> str:
        return json.dumps(self.to_dict(), **kwargs)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "FidelityReport":
        return cls(
            score=float(d["score"]),
            per_category=dict(d.get("per_category", {})),
            outcomes=tuple(
                ProbeOutcome.from_dict(o) for o in d.get("outcomes", [])
            ),
            method=str(d["method"]),
            generator=d.get("generator"),
            answerer=d.get("answerer"),
            judge=d.get("judge"),
            seed=(None if d.get("seed") is None else int(d["seed"])),
            caveats=tuple(d.get("caveats", [])),
            schema_version=str(d.get("schema_version", SCHEMA_VERSION)),
        )


# --------------------------------------------------------------------- #
# adapter protocols (every LLM touchpoint lives behind one of these)


class ProbeGenerator(Protocol):
    name: str

    def generate(
        self, source_context: str, n: int, seed: int | None = None
    ) -> Sequence[Probe]: ...


class Answerer(Protocol):
    name: str

    def answer(self, handoff_artifact: str, question: str) -> str: ...


class Judge(Protocol):
    name: str

    def judge(
        self, question: str, gold_answer: str, answer: str
    ) -> tuple[bool, str | None]: ...


def _normalize(s: str) -> str:
    return re.sub(r"\s+", " ", s.casefold()).strip()


class ExactMatchJudge:
    """Lenient normalized containment: correct when the normalized gold
    answer appears within the normalized answer. Deterministic and offline;
    a semantic judge is an adapter concern."""

    name = "exact-match"

    def judge(
        self, question: str, gold_answer: str, answer: str
    ) -> tuple[bool, str | None]:
        return _normalize(gold_answer) in _normalize(answer), None


# --------------------------------------------------------------------- #
# orchestration


def _weighted_score(outcomes: Sequence[ProbeOutcome]) -> float:
    total = sum(o.probe.weight for o in outcomes)
    if total <= 0:
        raise ValueError("no probe weight to score")
    return sum(o.probe.weight for o in outcomes if o.correct) / total


def evaluate_handoff(
    handoff_artifact: str,
    *,
    answerer: Answerer,
    probes: Sequence[Probe] | None = None,
    source_context: str | None = None,
    probe_generator: ProbeGenerator | None = None,
    judge: Judge | None = None,
    n: int = 10,
    seed: int | None = None,
    method: str = "probe-qa-0.1",
) -> FidelityReport:
    """Run the probe-QA protocol against a handoff artifact.

    Supply pre-built probes (fully offline) or a source_context plus a
    probe_generator. The judge defaults to ExactMatchJudge.
    """
    if probes is None:
        if probe_generator is None or source_context is None:
            raise ValueError(
                "supply probes, or source_context with a probe_generator"
            )
        probes = list(probe_generator.generate(source_context, n, seed))
    if not probes:
        raise ValueError("no probes to evaluate")

    chosen_judge: Judge = judge or ExactMatchJudge()

    outcomes: list[ProbeOutcome] = []
    for probe in probes:
        answer = answerer.answer(handoff_artifact, probe.question)
        answerable = bool(answer and answer.strip())
        correct = False
        note: str | None = None
        if answerable:
            correct, note = chosen_judge.judge(
                probe.question, probe.gold_answer, answer
            )
        outcomes.append(
            ProbeOutcome(
                probe=probe,
                answer=answer if answerable else None,
                answerable=answerable,
                correct=correct,
                judge_note=note,
            )
        )

    per_category: dict[str, float] = {}
    for category in {o.probe.category for o in outcomes}:
        members = [o for o in outcomes if o.probe.category is category]
        per_category[category.value] = _weighted_score(members)

    caveats = [
        "answerability judged by non-empty response only (0.1)",
    ]
    if isinstance(chosen_judge, ExactMatchJudge):
        caveats.append("exact-match judging is lenient normalized containment")

    return FidelityReport(
        score=_weighted_score(outcomes),
        per_category=per_category,
        outcomes=tuple(outcomes),
        method=method,
        generator=(
            getattr(probe_generator, "name", type(probe_generator).__name__)
            if probe_generator is not None
            else None
        ),
        answerer=getattr(answerer, "name", type(answerer).__name__),
        judge=getattr(chosen_judge, "name", type(chosen_judge).__name__),
        seed=seed,
        caveats=tuple(caveats),
    )


__all__ = [
    "ProbeCategory",
    "Probe",
    "ProbeOutcome",
    "FidelityReport",
    "ProbeGenerator",
    "Answerer",
    "Judge",
    "ExactMatchJudge",
    "evaluate_handoff",
]
