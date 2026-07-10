//! ctxmaster: the context gauge, hero surface of the tokenmaster family
//! (contract decision D10). Port of js/ctxmaster/src/gauge.ts.
//!
//! Renders a tokenmaster MeterState as a terminal panel: a zone-colored
//! fill bar against the effective window with threshold ticks, and
//! ancillary rows for context accounting, velocity, ETA, zone, and the
//! optional extras (reserved output, hidden overhead, cache prefix). Every
//! number displayed comes straight from MeterState; the gauge computes
//! nothing itself.
//!
//! Zero dependencies beyond the core by design (ruling A precedent):
//! colors and the live in-place redraw are raw ANSI escape sequences.
//! Color support is detected from NO_COLOR, FORCE_COLOR, TERM=dumb, and
//! TTY state when writing to the default stream; a custom write sink
//! defaults to plain text unless colors are requested explicitly. The
//! palette approximates the Python wrapper's rich styles (green, yellow3,
//! red3, grey37) in 256-color ANSI.
//!
//! Windows note: raw ANSI renders correctly in Windows Terminal and modern
//! PowerShell; a legacy conhost without virtual terminal processing shows
//! escape codes instead. (Node enables VT for JS programs automatically; a
//! plain Rust binary does not, which is the one caveat this wrapper
//! carries that the JS one does not.)
//!
//! Note on threshold ticks: MeterState (schema 0.1) does not carry the
//! zone thresholds, so the gauge takes them as display parameters
//! defaulting to the contract values (caution 0.70, critical 0.85). A
//! Meter configured with custom thresholds should be paired with a gauge
//! constructed to match. Promoting thresholds into MeterState is a schema
//! 0.2 candidate.
//!
//! Rust surface notes: `attach` and `live` return the underlying
//! SubscriptionId, so stopping is `meter.unsubscribe(id)`; a stop-handle
//! owning the meter is not expressible under ownership. The gauge is Clone
//! (the sink is shared behind an Arc), which is how the subscribed
//! closures carry their own copy.

use std::io::{IsTerminal, Write};
use std::sync::Arc;

use tokenmaster::{Error, Event, EventKind, Meter, MeterState, SubscriptionId, Zone};

// ------------------------------------------------------------------------ //
// ANSI machinery

const RESET: &str = "\u{1b}[0m";
const DIM: &str = "2";
const BOLD: &str = "1";
const GREY: &str = "38;5;59";

/// SGR color code per zone, approximating the rich palette.
pub fn zone_style(zone: Zone) -> &'static str {
    match zone {
        Zone::Green => "32",
        Zone::Caution => "38;5;184",
        Zone::Critical => "38;5;160",
    }
}

const FILLED: char = '\u{2588}'; // full block
const EMPTY: char = '\u{2591}'; // light shade
const TICK: char = '\u{2502}'; // vertical line

const TOP_LEFT: char = '\u{256d}';
const TOP_RIGHT: char = '\u{256e}';
const BOTTOM_LEFT: char = '\u{2570}';
const BOTTOM_RIGHT: char = '\u{256f}';
const HORIZONTAL: &str = "\u{2500}";
const VERTICAL: char = '\u{2502}';

/// Remove the SGR sequences this module emits (ESC [ ... m).
fn strip_ansi(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if c == 'm' {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Display width in characters (the glyphs used here are all single-cell).
fn display_width(text: &str) -> usize {
    strip_ansi(text).chars().count()
}

fn detect_colors() -> bool {
    if std::env::var_os("NO_COLOR").is_some() {
        return false;
    }
    if let Some(value) = std::env::var_os("FORCE_COLOR") {
        if value != "0" {
            return true;
        }
    }
    if std::env::var_os("TERM").map_or(false, |term| term == "dumb") {
        return false;
    }
    std::io::stdout().is_terminal()
}

// ------------------------------------------------------------------------ //
// number formatting mirroring the reference wrappers' display strings

fn group_digits(digits: &str) -> String {
    let mut out = String::new();
    let len = digits.len();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (len - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// Python "{:,}" on integers.
fn commas(n: i64) -> String {
    let body = group_digits(&n.unsigned_abs().to_string());
    if n < 0 {
        format!("-{body}")
    } else {
        body
    }
}

/// Python "{:,.0f}".
fn commas0(x: f64) -> String {
    commas(x.round() as i64)
}

/// Python "{:,.1f}".
fn commas1(x: f64) -> String {
    let fixed = format!("{:.1}", x.abs());
    let dot = fixed.find('.').expect("fixed formatting has a dot");
    let body = format!("{}{}", group_digits(&fixed[..dot]), &fixed[dot..]);
    if x < 0.0 {
        format!("-{body}")
    } else {
        body
    }
}

/// Python "{:6.1%}".
fn percent6(fraction: f64) -> String {
    format!("{:>6}", format!("{:.1}%", fraction * 100.0))
}

// ------------------------------------------------------------------------ //
// gauge

/// Construction options; the reference's keyword arguments. Construct with
/// [`GaugeOptions::default`] and override fields via struct update.
pub struct GaugeOptions {
    /// Output sink; defaults to stdout with a flush per write.
    pub write: Option<Box<dyn Fn(&str) + Send + Sync>>,
    /// Emit ANSI colors. Defaults to environment detection for the default
    /// stream, and to false when a custom write sink is supplied.
    pub colors: Option<bool>,
    pub bar_width: usize,
    pub caution: f64,
    pub critical: f64,
}

impl Default for GaugeOptions {
    fn default() -> Self {
        GaugeOptions {
            write: None,
            colors: None,
            bar_width: 50,
            caution: 0.70,
            critical: 0.85,
        }
    }
}

/// Terminal renderer for MeterState.
#[derive(Clone)]
pub struct ContextGauge {
    bar_width: usize,
    caution: f64,
    critical: f64,
    colors: bool,
    write: Arc<dyn Fn(&str) + Send + Sync>,
}

impl Default for ContextGauge {
    fn default() -> Self {
        ContextGauge::new()
    }
}

impl ContextGauge {
    /// Default gauge: stdout, environment-detected colors, bar width 50.
    pub fn new() -> ContextGauge {
        ContextGauge::with_options(GaugeOptions::default()).expect("defaults are valid")
    }

    pub fn with_options(options: GaugeOptions) -> Result<ContextGauge, Error> {
        if options.bar_width < 5 {
            return Err(Error::Value("bar_width must be at least 5".to_string()));
        }
        let colors = options.colors.unwrap_or(if options.write.is_some() {
            false
        } else {
            detect_colors()
        });
        let write: Arc<dyn Fn(&str) + Send + Sync> = match options.write {
            Some(sink) => Arc::from(sink),
            None => Arc::new(|text: &str| {
                let mut out = std::io::stdout();
                let _ = out.write_all(text.as_bytes());
                let _ = out.flush();
            }),
        };
        Ok(ContextGauge {
            bar_width: options.bar_width,
            caution: options.caution,
            critical: options.critical,
            colors,
            write,
        })
    }

    // ------------------------------------------------------------------ //
    // rendering (pure)

    fn paint(&self, text: &str, code: &str) -> String {
        if self.colors {
            format!("\u{1b}[{code}m{text}{RESET}")
        } else {
            text.to_string()
        }
    }

    /// Render the full panel for a state; returns a string, ANSI included
    /// when colors are enabled.
    pub fn render(&self, state: &MeterState) -> String {
        let zone_code = zone_style(state.zone);
        let mut content_lines = vec![self.bar_line(state)];
        content_lines.extend(self.info_rows(state));
        let title = format!("ctxmaster \u{b7} {}", state.model_id);
        let subtitle = format!("turn {}", state.turns);

        let mut width = title.chars().count().max(subtitle.chars().count());
        for line in &content_lines {
            width = width.max(display_width(line));
        }
        let inner = width + 2; // padding (0, 1)

        let top = self.border_line(TOP_LEFT, TOP_RIGHT, &title, inner, zone_code);
        let bottom = self.border_line(BOTTOM_LEFT, BOTTOM_RIGHT, &subtitle, inner, zone_code);
        let side = self.paint(&VERTICAL.to_string(), zone_code);
        let mut lines = vec![top];
        for line in &content_lines {
            let pad = " ".repeat(width - display_width(line));
            lines.push(format!("{side} {line}{pad} {side}"));
        }
        lines.push(bottom);
        lines.join("\n")
    }

    fn border_line(
        &self,
        left: char,
        right: char,
        label: &str,
        inner: usize,
        code: &str,
    ) -> String {
        let text = format!(" {label} ");
        let dashes = inner.saturating_sub(text.chars().count());
        let left_dashes = dashes / 2;
        let right_dashes = dashes - left_dashes;
        format!(
            "{}{text}{}",
            self.paint(&format!("{left}{}", HORIZONTAL.repeat(left_dashes)), code),
            self.paint(&format!("{}{right}", HORIZONTAL.repeat(right_dashes)), code)
        )
    }

    fn bar_line(&self, state: &MeterState) -> String {
        let width = self.bar_width;
        let fill = state.fill_effective.clamp(0.0, 1.0);
        let filled = (fill * width as f64).round() as usize;
        let ticks = [
            ((self.caution * width as f64).round() as usize).min(width - 1),
            ((self.critical * width as f64).round() as usize).min(width - 1),
        ];

        // Group consecutive same-style cells so the ANSI output stays
        // compact.
        let zone_code = zone_style(state.zone);
        let mut segments: Vec<(String, &str)> = Vec::new();
        for i in 0..width {
            let (ch, code) = if i < filled {
                (FILLED, zone_code)
            } else if ticks.contains(&i) {
                (TICK, DIM)
            } else {
                (EMPTY, GREY)
            };
            match segments.last_mut() {
                Some((text, last_code)) if *last_code == code => text.push(ch),
                _ => segments.push((ch.to_string(), code)),
            }
        }
        let bar: String = segments
            .iter()
            .map(|(text, code)| self.paint(text, code))
            .collect();
        format!(
            "{bar}{}",
            self.paint(&format!(" {}", percent6(state.fill_effective)), BOLD)
        )
    }

    fn info_rows(&self, state: &MeterState) -> Vec<String> {
        let mut rows: Vec<(&str, String)> = Vec::new();

        rows.push((
            "context",
            format!(
                "{} / {} effective ({} nominal)",
                commas(state.used_tokens),
                commas(state.window_effective),
                commas(state.window_nominal)
            ),
        ));
        rows.push(("capacity", state.effective_source.clone()));

        match (state.velocity, state.velocity_std) {
            (Some(velocity), Some(velocity_std)) => rows.push((
                "velocity",
                format!(
                    "{} \u{b1} {} tok/turn",
                    commas0(velocity),
                    commas0(velocity_std)
                ),
            )),
            _ => rows.push((
                "velocity",
                state
                    .provenance
                    .get("velocity")
                    .cloned()
                    .unwrap_or_else(|| "unavailable".to_string()),
            )),
        }

        match state.eta_turns {
            Some(eta) => rows.push((
                "eta",
                format!(
                    "{} turns ({} conservative)",
                    commas1(eta.expected),
                    commas1(eta.conservative)
                ),
            )),
            None => rows.push((
                "eta",
                state
                    .provenance
                    .get("eta_turns")
                    .cloned()
                    .unwrap_or_else(|| "unavailable".to_string()),
            )),
        }

        rows.push((
            "zone",
            self.paint(
                &state.zone.as_str().to_uppercase(),
                &format!("{BOLD};{}", zone_style(state.zone)),
            ),
        ));

        if state.reserved_output != 0 {
            rows.push((
                "reserved",
                format!("{} tok output", commas(state.reserved_output)),
            ));
        }
        if let Some(hidden) = state.hidden_overhead {
            rows.push((
                "overhead",
                format!("{} tok (system prompt + tool schemas)", commas(hidden)),
            ));
        }
        if let Some(cache) = state.cache {
            rows.push((
                "cache",
                format!("~{} tok stable prefix", commas(cache.stable_prefix_tokens)),
            ));
        }

        let label_width = rows
            .iter()
            .map(|(label, _)| label.chars().count())
            .max()
            .unwrap_or(0);
        rows.iter()
            .map(|(label, value)| {
                format!(
                    "{}  {value}",
                    self.paint(&format!("{label:<label_width$}"), DIM)
                )
            })
            .collect()
    }

    // ------------------------------------------------------------------ //
    // output

    pub fn print(&self, state: &MeterState) {
        (self.write)(&format!("{}\n", self.render(state)));
    }

    /// Print a fresh gauge on every recorded turn; stop with
    /// `meter.unsubscribe(id)`.
    pub fn attach(&self, meter: &mut Meter) -> SubscriptionId {
        let gauge = self.clone();
        meter.subscribe(move |event: &Event| {
            if let EventKind::TurnRecorded { state, .. } = &event.kind {
                gauge.print(state);
            }
        })
    }

    /// In-place updating gauge bound to a meter, for interactive use.
    ///
    /// Draws immediately and redraws on every recorded turn by
    /// cursor-repositioning over the previous frame (intended for TTY
    /// output). Stop with `meter.unsubscribe(id)`.
    pub fn live(&self, meter: &mut Meter) -> SubscriptionId {
        let gauge = self.clone();
        let first = gauge.render(&meter.state());
        let mut height = first.chars().filter(|&c| c == '\n').count() + 1;
        (gauge.write)(&format!("{first}\n"));
        meter.subscribe(move |event: &Event| {
            if let EventKind::TurnRecorded { state, .. } = &event.kind {
                let rendered = gauge.render(state);
                let up = format!("\u{1b}[{height}A\u{1b}[0J");
                height = rendered.chars().filter(|&c| c == '\n').count() + 1;
                (gauge.write)(&format!("{up}{rendered}\n"));
            }
        })
    }
}

// ------------------------------------------------------------------------ //
// unit tests for the module-private helpers

#[cfg(test)]
mod tests {
    use super::{commas, commas0, commas1, percent6, strip_ansi};

    #[test]
    fn number_formatting_matches_the_reference_display_strings() {
        assert_eq!(commas(0), "0");
        assert_eq!(commas(1_234_567), "1,234,567");
        assert_eq!(commas(-1_234), "-1,234");
        assert_eq!(commas0(2.6), "3");
        assert_eq!(commas1(1_234.56), "1,234.6");
        assert_eq!(percent6(0.5), " 50.0%");
        assert_eq!(percent6(0.055), "  5.5%");
        assert_eq!(percent6(1.234), "123.4%");
    }

    #[test]
    fn strip_ansi_removes_sgr_sequences() {
        assert_eq!(strip_ansi("\u{1b}[32mhello\u{1b}[0m"), "hello");
        assert_eq!(strip_ansi("plain"), "plain");
        assert_eq!(strip_ansi("\u{1b}[1;38;5;160mX\u{1b}[0m!"), "X!");
    }
}
