//! Build identity helpers.

pub const BASE_VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn channel() -> &'static str {
    non_empty(option_env!("HERDR_BUILD_CHANNEL")).unwrap_or("stable")
}

pub fn build_id() -> Option<&'static str> {
    non_empty(option_env!("HERDR_BUILD_ID"))
}

/// Git short commit this binary was built from, when known.
///
/// Populated by `build.rs` from an explicit `HERDR_BUILD_COMMIT` (release CI)
/// or the local git short SHA. Absent for builds outside a git checkout.
pub fn build_commit() -> Option<&'static str> {
    non_empty(option_env!("HERDR_BUILD_COMMIT"))
}

/// Base channel version without the build-commit suffix.
fn channel_version() -> String {
    match channel() {
        "stable" => BASE_VERSION.to_string(),
        channel => match build_id() {
            Some(build_id) => format!("{BASE_VERSION}-{channel}.{build_id}"),
            None => format!("{BASE_VERSION}-{channel}"),
        },
    }
}

/// Release/update identity without the local build-commit suffix.
pub fn release_label() -> String {
    channel_version()
}

pub fn version() -> String {
    match build_commit() {
        Some(commit) => format!("{}+{commit}", channel_version()),
        None => channel_version(),
    }
}

pub fn is_preview() -> bool {
    channel() == "preview"
}

fn non_empty(value: Option<&'static str>) -> Option<&'static str> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn stable_version_defaults_to_cargo_version() {
        assert!(!super::version().is_empty());
        assert!(super::version().starts_with(super::BASE_VERSION));
    }

    #[test]
    fn version_includes_commit_suffix_when_present() {
        // When build.rs supplied a commit, version() must surface it so fork
        // builds are distinguishable from upstream at the same release.
        if let Some(commit) = super::build_commit() {
            assert!(super::version().ends_with(&format!("+{commit}")));
        }
    }
}
