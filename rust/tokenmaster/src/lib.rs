//! tokenmaster: core context-budget metering and decision engine for LLM
//! applications.
//!
//! Placeholder release (0.0.1) reserving the crate name while the core API is
//! designed. Do not build against this version.

/// Crate version for this placeholder release.
pub const VERSION: &str = "0.0.1";

/// Basic project metadata for this placeholder release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct About {
    pub name: &'static str,
    pub version: &'static str,
    pub summary: &'static str,
    pub companion: &'static str,
    pub repository: &'static str,
    pub status: &'static str,
}

/// Return basic project metadata for this placeholder release.
pub fn about() -> About {
    About {
        name: "tokenmaster",
        version: VERSION,
        summary: "Core context-budget metering and decision engine for LLM applications.",
        companion: "ctxmaster (visualization layer)",
        repository: "https://github.com/jemsbhai/tokenmaster",
        status: "placeholder",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_matches_placeholder() {
        assert_eq!(VERSION, "0.0.1");
    }

    #[test]
    fn about_returns_expected_metadata() {
        let info = about();
        assert_eq!(info.name, "tokenmaster");
        assert_eq!(info.version, VERSION);
        assert_eq!(info.status, "placeholder");
        assert!(info.companion.contains("ctxmaster"));
    }
}
