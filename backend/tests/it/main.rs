//! The backend's integration tests, built as one test program so the API
//! and its dependencies are linked once instead of once per file. Run one
//! area with a filter: `scripts/test.sh --test it google::`.

mod common;
mod fixture;

mod account;
mod anthropic_client;
mod ats_job;
mod auth;
mod csrf;
mod digest;
mod email_prefs;
mod errors;
mod files;
mod followups;
mod funnel;
mod gaps;
mod google;
mod hardening;
mod health;
mod home;
mod isolation;
mod job_recovery;
mod legacy;
mod legacy_application;
mod letters_research;
mod live_ai;
mod master_cv;
mod migrations;
mod pipeline;
mod profile;
mod rate_limit;
mod render;
mod render_job;
mod review;
mod session_expiry;
mod setup;
mod site;
mod tavily_client;
mod tracking;
mod upload;
mod usage;
mod verify_code;
mod welcome_email;
mod writing_prefs;
