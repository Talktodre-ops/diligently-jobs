//! Small input validators shared by handlers. Each returns a field-tagged
//! `AppError::Validation` so the client can point at the offending input.

use crate::error::AppError;

/// Trim and require a non-empty string no longer than `max` characters.
pub fn required_text(field: &'static str, value: &str, max: usize) -> Result<String, AppError> {
    let v = value.trim();
    if v.is_empty() {
        return Err(AppError::validation(field, format!("{field} is required")));
    }
    max_len(field, v, max)?;
    Ok(v.to_string())
}

/// Trim an optional string; empty becomes `None`. Enforces `max` characters.
pub fn optional_text(
    field: &'static str,
    value: Option<&str>,
    max: usize,
) -> Result<Option<String>, AppError> {
    match value.map(str::trim) {
        None | Some("") => Ok(None),
        Some(v) => {
            max_len(field, v, max)?;
            Ok(Some(v.to_string()))
        }
    }
}

pub fn max_len(field: &'static str, value: &str, max: usize) -> Result<(), AppError> {
    if value.chars().count() > max {
        return Err(AppError::validation(
            field,
            format!("{field} must be at most {max} characters"),
        ));
    }
    Ok(())
}

/// Require `value` to be one of `allowed`.
pub fn one_of(field: &'static str, value: &str, allowed: &[&str]) -> Result<(), AppError> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(AppError::validation(
            field,
            format!("{field} must be one of: {}", allowed.join(", ")),
        ))
    }
}

/// Normalise and check an email address. Deliberately loose (one `@`, a dot in
/// the domain, no spaces, length limits); the verification email is the real
/// proof that the address works.
pub fn email(field: &'static str, value: &str) -> Result<String, AppError> {
    let v = value.trim().to_lowercase();
    let bad = || AppError::validation(field, "Enter a valid email address");
    if v.len() > 254 || v.chars().any(char::is_whitespace) {
        return Err(bad());
    }
    let (local, domain) = v.split_once('@').ok_or_else(bad)?;
    if local.is_empty()
        || local.len() > 64
        || domain.contains('@')
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
    {
        return Err(bad());
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_text_trims_and_rejects_empty() {
        assert_eq!(required_text("name", "  Ada ", 10).unwrap(), "Ada");
        assert!(required_text("name", "   ", 10).is_err());
    }

    #[test]
    fn length_limit_counts_characters_not_bytes() {
        assert!(max_len("x", "ééé", 3).is_ok());
        assert!(max_len("x", "éééé", 3).is_err());
    }

    #[test]
    fn optional_text_maps_blank_to_none() {
        assert_eq!(optional_text("x", Some("  "), 5).unwrap(), None);
        assert_eq!(optional_text("x", None, 5).unwrap(), None);
        assert_eq!(
            optional_text("x", Some(" a "), 5).unwrap(),
            Some("a".into())
        );
    }

    #[test]
    fn email_normalises_case_and_rejects_malformed() {
        assert_eq!(
            email("email", " Ada@Example.COM ").unwrap(),
            "ada@example.com"
        );
        for bad in [
            "",
            "ada",
            "ada@",
            "@x.com",
            "ada@x",
            "a b@x.com",
            "a@@x.com",
            "a@.com",
            "a@x.com.",
        ] {
            assert!(email("email", bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn one_of_checks_membership() {
        assert!(one_of("tone", "warm", &["direct", "warm"]).is_ok());
        assert!(one_of("tone", "loud", &["direct", "warm"]).is_err());
    }
}
