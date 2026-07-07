//! ctxmaster: visualization layer for tokenmaster.
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
    pub core: String,
    pub repository: &'static str,
    pub status: &'static str,
}

/// Return basic project metadata for this placeholder release.
pub fn about() -> About {
    About {
        name: "ctxmaster",
        version: VERSION,
        summary: "Visualization layer for tokenmaster: CLI, terminal gauge, and dashboard renderers.",
        core: format!("tokenmaster {}", tokenmaster::VERSION),
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
    fn about_reports_core_version() {
        let info = about();
        assert_eq!(info.name, "ctxmaster");
        assert!(info.core.contains(tokenmaster::VERSION));
        assert_eq!(info.status, "placeholder");
    }
}
