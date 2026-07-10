//! Bundled model registry: capacities and dated pricing, offline by design.
//!
//! The snapshot is embedded at compile time via include_str! from
//! rust/tokenmaster/data/models.json, a committed copy of the canonical
//! python/tokenmaster/src/tokenmaster/data/models.json (contract P6: nothing
//! phones home; refresh mechanisms will be explicit adapters). The copy is
//! forced, not preferred: cargo publish packages only files under the crate
//! root, so include_str! reaching into the Python package would fail the
//! publish verify build. A sync test asserts JSON equality against the
//! canonical file whenever it is reachable.
//!
//! Lookup accepts canonical ids ("anthropic:claude-sonnet-4-6"), bare names
//! ("claude-sonnet-4-6"), registered aliases, and dated snapshot suffixes
//! ("claude-haiku-4-5-20251001", "openai:gpt-5.5-2026-04-14").
//! User-registered profiles override bundled ones.
//!
//! Close-match suggestions port difflib.get_close_matches faithfully
//! (Ratcliff/Obershelp ratio via the same greedy longest-match recursion,
//! cutoff 0.6, top 3), translated from the JS port so all three languages
//! suggest the same corrections. The junk and autojunk heuristics never
//! engage below 200 characters and are omitted.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use serde_json::Value;

use crate::types::{as_map, opt_string, Error, ModelProfile};

const BUNDLED_MODELS: &str = include_str!("../data/models.json");

fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}

/// True for version/date tails like "20251001" or "2026-04-14".
fn is_dated_suffix(s: &str) -> bool {
    s.len() >= 4
        && s.chars().any(|c| c.is_ascii_digit())
        && s.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '.')
}

// ------------------------------------------------------------------------ //
// difflib.get_close_matches port

/// Sum of matching-block sizes exactly as CPython's SequenceMatcher computes
/// them: divide and conquer around the greedy longest match, earliest match
/// winning ties.
fn match_total(a: &[char], b: &[char]) -> usize {
    let mut b2j: HashMap<char, Vec<usize>> = HashMap::new();
    for (j, ch) in b.iter().enumerate() {
        b2j.entry(*ch).or_default().push(j);
    }

    let find_longest = |alo: usize, ahi: usize, blo: usize, bhi: usize| -> (usize, usize, usize) {
        let mut besti = alo;
        let mut bestj = blo;
        let mut bestsize = 0usize;
        let mut j2len: HashMap<usize, usize> = HashMap::new();
        for i in alo..ahi {
            let mut new_j2len: HashMap<usize, usize> = HashMap::new();
            if let Some(indices) = b2j.get(&a[i]) {
                for &j in indices {
                    if j < blo {
                        continue;
                    }
                    if j >= bhi {
                        break;
                    }
                    let k = if j == 0 {
                        1
                    } else {
                        j2len.get(&(j - 1)).copied().unwrap_or(0) + 1
                    };
                    new_j2len.insert(j, k);
                    if k > bestsize {
                        besti = i + 1 - k;
                        bestj = j + 1 - k;
                        bestsize = k;
                    }
                }
            }
            j2len = new_j2len;
        }
        (besti, bestj, bestsize)
    };

    let mut total = 0usize;
    let mut queue: Vec<(usize, usize, usize, usize)> = vec![(0, a.len(), 0, b.len())];
    while let Some((alo, ahi, blo, bhi)) = queue.pop() {
        let (i, j, k) = find_longest(alo, ahi, blo, bhi);
        if k > 0 {
            total += k;
            if alo < i && blo < j {
                queue.push((alo, i, blo, j));
            }
            if i + k < ahi && j + k < bhi {
                queue.push((i + k, ahi, j + k, bhi));
            }
        }
    }
    total
}

fn ratio(a: &str, b: &str) -> f64 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let length = a.len() + b.len();
    if length == 0 {
        return 1.0;
    }
    2.0 * match_total(&a, &b) as f64 / length as f64
}

fn get_close_matches(word: &str, possibilities: &[&str], n: usize, cutoff: f64) -> Vec<String> {
    let mut scored: Vec<(f64, &str)> = Vec::new();
    for candidate in possibilities {
        // a = candidate, b = word, matching difflib's sequence assignment.
        let r = ratio(candidate, word);
        if r >= cutoff {
            scored.push((r, candidate));
        }
    }
    // heapq.nlargest on (score, value) pairs: score descending, then value
    // descending for ties.
    scored.sort_by(|p, q| {
        q.0.partial_cmp(&p.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| q.1.cmp(p.1))
    });
    scored.into_iter().take(n).map(|(_, v)| v.to_string()).collect()
}

// ------------------------------------------------------------------------ //
// registry

/// Model profiles keyed by canonical id, with alias resolution.
#[derive(Debug, Clone)]
pub struct Registry {
    snapshot_date: Option<String>,
    profiles: BTreeMap<String, ModelProfile>,
    alias: BTreeMap<String, String>,
}

impl Registry {
    pub fn new(snapshot_date: Option<String>) -> Registry {
        Registry {
            snapshot_date,
            profiles: BTreeMap::new(),
            alias: BTreeMap::new(),
        }
    }

    /// A fresh registry from the embedded snapshot.
    pub fn bundled() -> Registry {
        let v: Value = serde_json::from_str(BUNDLED_MODELS)
            .expect("bundled models.json parses as JSON");
        Registry::from_value(&v).expect("bundled models.json is a valid registry snapshot")
    }

    pub fn from_value(v: &Value) -> Result<Registry, Error> {
        let d = as_map(v, "Registry")?;
        let mut reg = Registry::new(opt_string(d, "snapshot_date", "Registry")?);
        match d.get("models") {
            None | Some(Value::Null) => {}
            Some(models_value) => {
                let models = models_value.as_array().ok_or_else(|| {
                    Error::Parse("Registry: field 'models' is not an array".to_string())
                })?;
                for entry_value in models {
                    let entry = as_map(entry_value, "Registry model entry")?;
                    let mut copy = entry.clone();
                    let mut aliases: Vec<String> = Vec::new();
                    match copy.remove("aliases") {
                        None | Some(Value::Null) => {}
                        Some(Value::Array(items)) => {
                            for item in items {
                                match item {
                                    Value::String(s) => aliases.push(s),
                                    _ => {
                                        return Err(Error::Parse(
                                            "Registry: alias entries must be strings".to_string(),
                                        ))
                                    }
                                }
                            }
                        }
                        Some(_) => {
                            return Err(Error::Parse(
                                "Registry: field 'aliases' is not an array".to_string(),
                            ))
                        }
                    }
                    let profile = ModelProfile::from_value(&Value::Object(copy))?;
                    let alias_refs: Vec<&str> = aliases.iter().map(String::as_str).collect();
                    reg.register(profile, &alias_refs);
                }
            }
        }
        Ok(reg)
    }

    /// Add or override a profile. Later registrations win.
    pub fn register(&mut self, profile: ModelProfile, aliases: &[&str]) {
        let canonical = norm(&profile.model_id);
        let provider = profile.provider.clone();
        self.profiles.insert(canonical.clone(), profile);
        self.alias.insert(canonical.clone(), canonical.clone());
        if let Some(idx) = canonical.find(':') {
            let bare = canonical[idx + 1..].to_string();
            self.alias.entry(bare).or_insert_with(|| canonical.clone());
        }
        for alias in aliases {
            let a = norm(alias);
            self.alias.insert(a.clone(), canonical.clone());
            if !a.contains(':') {
                self.alias
                    .entry(format!("{provider}:{a}"))
                    .or_insert_with(|| canonical.clone());
            }
        }
    }

    /// Resolve a model id: exact alias, then dated-suffix, else UnknownModel
    /// with close-match suggestions.
    pub fn get(&self, model_id: &str) -> Result<&ModelProfile, Error> {
        let key = norm(model_id);
        if let Some(hit) = self.alias.get(&key) {
            return Ok(self.profiles.get(hit).expect("alias target exists"));
        }

        // dated snapshot suffixes: longest known base wins
        let mut best: Option<&str> = None;
        for base in self.alias.keys() {
            if key.len() > base.len()
                && key.starts_with(base.as_str())
                && key.as_bytes()[base.len()] == b'-'
                && is_dated_suffix(&key[base.len() + 1..])
                && best.map_or(true, |b| base.len() > b.len())
            {
                best = Some(base);
            }
        }
        if let Some(base) = best {
            let canonical = &self.alias[base];
            return Ok(self.profiles.get(canonical).expect("alias target exists"));
        }

        let candidates: Vec<&str> = self.alias.keys().map(String::as_str).collect();
        let suggestions = get_close_matches(&key, &candidates, 3, 0.6);
        Err(Error::UnknownModel {
            model_id: model_id.to_string(),
            suggestions,
        })
    }

    /// Whether the id resolves (Python: `model_id in registry`).
    pub fn contains(&self, model_id: &str) -> bool {
        self.get(model_id).is_ok()
    }

    pub fn snapshot_date(&self) -> Option<&str> {
        self.snapshot_date.as_deref()
    }

    /// Canonical ids, sorted.
    pub fn ids(&self) -> Vec<&str> {
        self.profiles.keys().map(String::as_str).collect()
    }

    /// Profiles sorted by canonical id.
    pub fn profiles(&self) -> Vec<&ModelProfile> {
        self.profiles.values().collect()
    }
}

// ------------------------------------------------------------------------ //
// process-wide default

static DEFAULT: OnceLock<Registry> = OnceLock::new();

/// The bundled registry, loaded once per process.
pub fn default_registry() -> &'static Registry {
    DEFAULT.get_or_init(Registry::bundled)
}

/// Resolve against the default registry, returning an owned profile.
pub fn get_profile(model_id: &str) -> Result<ModelProfile, Error> {
    default_registry().get(model_id).map(|p| p.clone())
}

// ------------------------------------------------------------------------ //
// unit tests for the module-private helpers

#[cfg(test)]
mod tests {
    use super::{get_close_matches, is_dated_suffix, ratio};

    #[test]
    fn dated_suffix_predicate() {
        assert!(is_dated_suffix("20251001"));
        assert!(is_dated_suffix("2026-04-14"));
        assert!(is_dated_suffix("4.1-2026"));
        assert!(is_dated_suffix("2026")); // len 4, all digits: valid
        assert!(!is_dated_suffix("abc"));
        assert!(!is_dated_suffix("123")); // too short
        assert!(!is_dated_suffix("----")); // no digit
        assert!(!is_dated_suffix("preview"));
    }

    #[test]
    fn difflib_pinned_examples() {
        // The classic difflib documentation examples.
        assert!((ratio("abcd", "abcd") - 1.0).abs() < 1e-12);
        assert!((ratio("abcd", "bcde") - 0.75).abs() < 1e-12);
        let matches = get_close_matches("appel", &["ape", "apple", "peach", "puppy"], 3, 0.6);
        assert_eq!(matches, vec!["apple".to_string(), "ape".to_string()]);
    }
}
