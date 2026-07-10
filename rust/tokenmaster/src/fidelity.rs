//! Handoff fidelity protocol (contract section 6). Port of
//! python/tokenmaster/src/tokenmaster/fidelity.py.
//!
//! "Was that continuation prompt any good" becomes measurable: derive probe
//! question-answer pairs from the source context, answer them with only the
//! handoff artifact in view, score answerable/correct, and report a
//! weighted fidelity in [0, 1] overall and per category.
//!
//! The core owns the data structures and orchestration only. Every LLM
//! touchpoint is an adapter behind a small trait (ProbeGenerator, Answerer,
//! Judge), so the protocol runs fully offline with user-supplied probes and
//! a scripted answerer. Reports carry method, adapter identities, and the
//! seed, so a result is reproducible, plus explicit caveats about what
//! version 0.1 does naively (answerability is judged by non-empty response;
//! the built-in judge is lenient normalized containment).
//!
//! Rust surface notes: adapter methods return Result because raising is how
//! the reference expresses fallible adapter calls, and Result is that
//! language feature here; the built-in judge always returns Ok. The
//! reference's isinstance check for the containment caveat maps to a
//! name() check, which also covers an explicitly injected built-in judge.
//! per_category is a BTreeMap so serialized reports are deterministic.

use std::collections::BTreeMap;
use std::str::FromStr;

use serde::Serialize;
use serde_json::Value;

use crate::types::{
    as_map, opt_i64, opt_string, req_string, req_value, string_or, to_f64, Error, SCHEMA_VERSION,
};

// ------------------------------------------------------------------------ //
// probe data model

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeCategory {
    Objective,
    Decisions,
    Constraints,
    State,
    Artifacts,
}

impl ProbeCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            ProbeCategory::Objective => "objective",
            ProbeCategory::Decisions => "decisions",
            ProbeCategory::Constraints => "constraints",
            ProbeCategory::State => "state",
            ProbeCategory::Artifacts => "artifacts",
        }
    }
}

impl FromStr for ProbeCategory {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self, Error> {
        match s {
            "objective" => Ok(ProbeCategory::Objective),
            "decisions" => Ok(ProbeCategory::Decisions),
            "constraints" => Ok(ProbeCategory::Constraints),
            "state" => Ok(ProbeCategory::State),
            "artifacts" => Ok(ProbeCategory::Artifacts),
            other => Err(Error::Value(format!(
                "'{other}' is not a valid ProbeCategory"
            ))),
        }
    }
}

/// One question with its gold answer, derived from the source context.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Probe {
    pub id: String,
    pub category: ProbeCategory,
    pub question: String,
    pub gold_answer: String,
    pub weight: f64,
}

impl Probe {
    pub fn new(
        id: impl Into<String>,
        category: ProbeCategory,
        question: impl Into<String>,
        gold_answer: impl Into<String>,
        weight: f64,
    ) -> Result<Probe, Error> {
        let probe = Probe {
            id: id.into(),
            category,
            question: question.into(),
            gold_answer: gold_answer.into(),
            weight,
        };
        probe.validate()?;
        Ok(probe)
    }

    /// Reference validation (`__post_init__`); message is normative.
    pub fn validate(&self) -> Result<(), Error> {
        if self.weight <= 0.0 {
            return Err(Error::Value("probe weight must be positive".to_string()));
        }
        Ok(())
    }

    pub fn from_value(v: &Value) -> Result<Probe, Error> {
        let d = as_map(v, "Probe")?;
        let weight = match d.get("weight") {
            None | Some(Value::Null) => 1.0,
            Some(w) => to_f64(w, "Probe", "weight")?,
        };
        let probe = Probe {
            id: req_string(d, "id", "Probe")?,
            category: ProbeCategory::from_str(&req_string(d, "category", "Probe")?)?,
            question: req_string(d, "question", "Probe")?,
            gold_answer: req_string(d, "gold_answer", "Probe")?,
            weight,
        };
        probe.validate()?;
        Ok(probe)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProbeOutcome {
    pub probe: Probe,
    pub answer: Option<String>,
    pub answerable: bool,
    pub correct: bool,
    pub judge_note: Option<String>,
}

fn req_bool(d: &serde_json::Map<String, Value>, key: &str, ctx: &str) -> Result<bool, Error> {
    match d.get(key) {
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(Error::Parse(format!("{ctx}: field '{key}' is not a boolean"))),
        None => Err(Error::Parse(format!("{ctx}: missing required field '{key}'"))),
    }
}

impl ProbeOutcome {
    pub fn from_value(v: &Value) -> Result<ProbeOutcome, Error> {
        let d = as_map(v, "ProbeOutcome")?;
        Ok(ProbeOutcome {
            probe: Probe::from_value(req_value(d, "probe", "ProbeOutcome")?)?,
            answer: opt_string(d, "answer", "ProbeOutcome")?,
            answerable: req_bool(d, "answerable", "ProbeOutcome")?,
            correct: req_bool(d, "correct", "ProbeOutcome")?,
            judge_note: opt_string(d, "judge_note", "ProbeOutcome")?,
        })
    }
}

/// Outcome of one handoff evaluation. score is a weighted mean in [0, 1].
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FidelityReport {
    pub score: f64,
    pub per_category: BTreeMap<String, f64>,
    pub outcomes: Vec<ProbeOutcome>,
    pub method: String,
    pub generator: Option<String>,
    pub answerer: Option<String>,
    pub judge: Option<String>,
    pub seed: Option<i64>,
    pub caveats: Vec<String>,
    pub schema_version: String,
}

impl FidelityReport {
    /// JSON string form. Infallible for any report the core produces.
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("FidelityReport serialization")
    }

    pub fn from_value(v: &Value) -> Result<FidelityReport, Error> {
        let d = as_map(v, "FidelityReport")?;
        let mut per_category = BTreeMap::new();
        match d.get("per_category") {
            None | Some(Value::Null) => {}
            Some(Value::Object(o)) => {
                for (key, value) in o {
                    per_category.insert(key.clone(), to_f64(value, "FidelityReport", key)?);
                }
            }
            Some(_) => {
                return Err(Error::Parse(
                    "FidelityReport: field 'per_category' is not an object".to_string(),
                ))
            }
        }
        let mut outcomes = Vec::new();
        match d.get("outcomes") {
            None | Some(Value::Null) => {}
            Some(Value::Array(items)) => {
                for item in items {
                    outcomes.push(ProbeOutcome::from_value(item)?);
                }
            }
            Some(_) => {
                return Err(Error::Parse(
                    "FidelityReport: field 'outcomes' is not an array".to_string(),
                ))
            }
        }
        let mut caveats = Vec::new();
        match d.get("caveats") {
            None | Some(Value::Null) => {}
            Some(Value::Array(items)) => {
                for item in items {
                    match item {
                        Value::String(s) => caveats.push(s.clone()),
                        _ => {
                            return Err(Error::Parse(
                                "FidelityReport: caveat entries must be strings".to_string(),
                            ))
                        }
                    }
                }
            }
            Some(_) => {
                return Err(Error::Parse(
                    "FidelityReport: field 'caveats' is not an array".to_string(),
                ))
            }
        }
        let score = match d.get("score") {
            None => {
                return Err(Error::Parse(
                    "FidelityReport: missing required field 'score'".to_string(),
                ))
            }
            Some(v) => to_f64(v, "FidelityReport", "score")?,
        };
        Ok(FidelityReport {
            score,
            per_category,
            outcomes,
            method: req_string(d, "method", "FidelityReport")?,
            generator: opt_string(d, "generator", "FidelityReport")?,
            answerer: opt_string(d, "answerer", "FidelityReport")?,
            judge: opt_string(d, "judge", "FidelityReport")?,
            seed: opt_i64(d, "seed", "FidelityReport")?,
            caveats,
            schema_version: string_or(d, "schema_version", SCHEMA_VERSION, "FidelityReport")?,
        })
    }
}

// ------------------------------------------------------------------------ //
// adapter traits (every LLM touchpoint lives behind one of these)

pub trait ProbeGenerator: Send + Sync {
    fn name(&self) -> &str;
    fn generate(
        &self,
        source_context: &str,
        n: usize,
        seed: Option<i64>,
    ) -> Result<Vec<Probe>, Error>;
}

pub trait Answerer: Send + Sync {
    fn name(&self) -> &str;
    fn answer(&self, handoff_artifact: &str, question: &str) -> Result<String, Error>;
}

pub trait Judge: Send + Sync {
    fn name(&self) -> &str;
    fn judge(
        &self,
        question: &str,
        gold_answer: &str,
        answer: &str,
    ) -> Result<(bool, Option<String>), Error>;
}

fn normalize(s: &str) -> String {
    s.to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Lenient normalized containment: correct when the normalized gold answer
/// appears within the normalized answer. Deterministic and offline; a
/// semantic judge is an adapter concern.
#[derive(Debug, Clone, Copy, Default)]
pub struct ExactMatchJudge;

impl Judge for ExactMatchJudge {
    fn name(&self) -> &str {
        "exact-match"
    }

    fn judge(
        &self,
        _question: &str,
        gold_answer: &str,
        answer: &str,
    ) -> Result<(bool, Option<String>), Error> {
        Ok((normalize(answer).contains(&normalize(gold_answer)), None))
    }
}

// ------------------------------------------------------------------------ //
// orchestration

fn weighted_score(outcomes: &[&ProbeOutcome]) -> Result<f64, Error> {
    let total: f64 = outcomes.iter().map(|o| o.probe.weight).sum();
    if total <= 0.0 {
        return Err(Error::Value("no probe weight to score".to_string()));
    }
    let correct: f64 = outcomes
        .iter()
        .filter(|o| o.correct)
        .map(|o| o.probe.weight)
        .sum();
    Ok(correct / total)
}

/// Options for [`evaluate_handoff_with`]; the reference's keyword
/// arguments. Construct with [`EvaluateOptions::new`] and override fields
/// via struct update.
pub struct EvaluateOptions<'a> {
    pub answerer: &'a dyn Answerer,
    pub probes: Option<Vec<Probe>>,
    pub source_context: Option<&'a str>,
    pub probe_generator: Option<&'a dyn ProbeGenerator>,
    pub judge: Option<&'a dyn Judge>,
    pub n: usize,
    pub seed: Option<i64>,
    pub method: String,
}

impl<'a> EvaluateOptions<'a> {
    pub fn new(answerer: &'a dyn Answerer) -> Self {
        EvaluateOptions {
            answerer,
            probes: None,
            source_context: None,
            probe_generator: None,
            judge: None,
            n: 10,
            seed: None,
            method: "probe-qa-0.1".to_string(),
        }
    }
}

/// Run the probe-QA protocol against a handoff artifact with pre-built
/// probes (the fully offline path, default judge and method).
pub fn evaluate_handoff(
    handoff_artifact: &str,
    answerer: &dyn Answerer,
    probes: &[Probe],
) -> Result<FidelityReport, Error> {
    evaluate_handoff_with(
        handoff_artifact,
        EvaluateOptions {
            probes: Some(probes.to_vec()),
            ..EvaluateOptions::new(answerer)
        },
    )
}

/// Run the probe-QA protocol against a handoff artifact.
///
/// Supply pre-built probes (fully offline) or a source_context plus a
/// probe_generator. The judge defaults to ExactMatchJudge.
pub fn evaluate_handoff_with(
    handoff_artifact: &str,
    options: EvaluateOptions<'_>,
) -> Result<FidelityReport, Error> {
    let probes = match options.probes {
        Some(probes) => probes,
        None => match (options.probe_generator, options.source_context) {
            (Some(generator), Some(source_context)) => {
                generator.generate(source_context, options.n, options.seed)?
            }
            _ => {
                return Err(Error::Value(
                    "supply probes, or source_context with a probe_generator".to_string(),
                ))
            }
        },
    };
    if probes.is_empty() {
        return Err(Error::Value("no probes to evaluate".to_string()));
    }

    let default_judge = ExactMatchJudge;
    let chosen_judge: &dyn Judge = match options.judge {
        Some(judge) => judge,
        None => &default_judge,
    };

    let mut outcomes: Vec<ProbeOutcome> = Vec::new();
    for probe in &probes {
        let answer = options.answerer.answer(handoff_artifact, &probe.question)?;
        let answerable = !answer.trim().is_empty();
        let mut correct = false;
        let mut note = None;
        if answerable {
            let (c, n) = chosen_judge.judge(&probe.question, &probe.gold_answer, &answer)?;
            correct = c;
            note = n;
        }
        outcomes.push(ProbeOutcome {
            probe: probe.clone(),
            answer: if answerable { Some(answer) } else { None },
            answerable,
            correct,
            judge_note: note,
        });
    }

    let mut per_category = BTreeMap::new();
    let mut categories: Vec<ProbeCategory> = Vec::new();
    for outcome in &outcomes {
        if !categories.contains(&outcome.probe.category) {
            categories.push(outcome.probe.category);
        }
    }
    for category in categories {
        let members: Vec<&ProbeOutcome> = outcomes
            .iter()
            .filter(|o| o.probe.category == category)
            .collect();
        per_category.insert(category.as_str().to_string(), weighted_score(&members)?);
    }

    let mut caveats = vec!["answerability judged by non-empty response only (0.1)".to_string()];
    if chosen_judge.name() == "exact-match" {
        caveats.push("exact-match judging is lenient normalized containment".to_string());
    }

    let all: Vec<&ProbeOutcome> = outcomes.iter().collect();
    let score = weighted_score(&all)?;
    Ok(FidelityReport {
        score,
        per_category,
        outcomes,
        method: options.method,
        generator: options.probe_generator.map(|g| g.name().to_string()),
        answerer: Some(options.answerer.name().to_string()),
        judge: Some(chosen_judge.name().to_string()),
        seed: options.seed,
        caveats,
        schema_version: SCHEMA_VERSION.to_string(),
    })
}

// ------------------------------------------------------------------------ //
// unit tests for the module-private helpers

#[cfg(test)]
mod tests {
    use super::normalize;

    #[test]
    fn normalize_collapses_whitespace_and_case() {
        assert_eq!(normalize("The License is   MIT.  "), "the license is mit.");
        assert_eq!(normalize("  a\tb\n c "), "a b c");
    }
}
