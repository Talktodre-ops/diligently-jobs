//! Live check of every prompt family against the real Claude and Tavily
//! APIs. Ignored by default because it spends money; run deliberately with
//! ANTHROPIC_API_KEY (and TAVILY_API_KEY) in the environment:
//!   cargo test --test live_ai_test -- --ignored --nocapture

use diligently_api::ai::anthropic::{AnthropicConfig, AnthropicLlm};
use diligently_api::ai::Llm;
use diligently_api::prompts::{
    ats_score, cover_letter, cv_for_prompt, cv_parse, cv_plain_text, follow_up, gap_bullet, gaps,
    jd_analysis, research, rewrites,
};
use diligently_api::render::{latex, resume::ResumeDoc, Paper};
use diligently_api::web::{Tavily, WebSearch};
use serde_json::json;

const JD: &str = "Senior Backend Engineer, Halcyon Health (Remote, Africa/Europe)

Halcyon Health builds claims-processing software for clinics. You will own services that ingest and reconcile insurance claims.

Requirements:
- 5+ years building backend services in Go or Rust
- PostgreSQL at scale, query tuning
- Event-driven systems (Kafka or similar)
- GraphQL API design
- Experience with HIPAA or other regulated health data

Nice to have: Kubernetes, Terraform, on-call leadership.";

fn cv() -> ResumeDoc {
    serde_json::from_value(json!({
        "header": { "name": "Ada Okafor", "title": "Senior Backend Engineer", "email": "ada@example.com" },
        "summary": "Backend engineer with 7 years building payment and ledger systems in Go and Rust.",
        "experience": [
            { "role": "Senior Backend Engineer", "company": "Northfold", "location": "Lagos", "start": "2021", "end": "Present",
              "bullets": [
                "Cut ledger reconciliation time by 60% by moving batch jobs to Kafka consumers in Go",
                "Designed the Postgres partitioning scheme for 400M payment rows",
                "Led a 4-person on-call rotation and wrote the incident runbooks"
              ] },
            { "role": "Backend Engineer", "company": "Quarry Labs", "start": "2018", "end": "2021",
              "bullets": [ "Built the billing API in Rust used by 30 merchant integrations", "Ran Terraform for 3 AWS accounts" ] }
        ],
        "skills": [{ "label": "Languages", "items": ["Go", "Rust", "SQL"] }, { "label": "Infra", "items": ["Postgres", "Kafka", "Kubernetes", "Terraform"] }],
        "education": [{ "institution": "University of Lagos", "degree": "B.Sc. Computer Science" }]
    }))
    .unwrap()
}

#[tokio::test]
#[ignore]
async fn every_prompt_family_against_the_real_api() {
    let cfg = AnthropicConfig::from_env()
        .unwrap()
        .expect("ANTHROPIC_API_KEY must be set");
    println!("model: {}", cfg.model);
    let llm = AnthropicLlm::new(cfg).unwrap();
    let doc = cv();
    let cv_text = cv_for_prompt(&doc);
    let mut total_in = 0;
    let mut total_out = 0;
    macro_rules! run {
        ($req:expr) => {{
            let started = std::time::Instant::now();
            let r = llm.complete($req).await.expect("model call");
            total_in += r.usage.input_tokens;
            total_out += r.usage.output_tokens;
            println!(
                "  [{} ms, in {} out {}, {}]",
                started.elapsed().as_millis(),
                r.usage.input_tokens,
                r.usage.output_tokens,
                r.model
            );
            r.value
        }};
    }

    println!("\n== jd_analysis");
    let jd = jd_analysis::parse(run!(jd_analysis::request(JD))).expect("jd parse");
    println!("{jd:#?}");
    assert!(jd.role.to_lowercase().contains("backend"));
    assert_eq!(jd.company.as_deref(), Some("Halcyon Health"));

    println!("\n== gap_analysis");
    let g = gaps::parse(
        run!(gaps::request(&cv_text, JD, &jd.required, &jd.nice_to_have)),
        &doc,
    )
    .expect("gaps parse");
    for x in &g {
        println!(
            "  {:8} {:13} {:?} {}",
            x.status, x.importance, x.evidence, x.requirement
        );
    }
    let hipaa = g
        .iter()
        .find(|x| x.requirement.to_lowercase().contains("hipaa"))
        .expect("HIPAA gap listed");
    assert_ne!(hipaa.status, "covered", "CV has no health data experience");

    println!("\n== rewrites");
    let rw = rewrites::parse(run!(rewrites::request(&cv_text, JD, &jd.keywords)), &doc)
        .expect("rewrites parse");
    println!("  summary: {:?}", rw.summary);
    for r in &rw.rewrites {
        println!(
            "  {} -> {}\n       why: {} (needs_number {})",
            r.bullet_id, r.rewrite, r.why, r.needs_number
        );
    }
    assert!(
        !rw.rewrites.is_empty(),
        "at least one rewrite survives the guards"
    );

    println!("\n== ats_score");
    let s = ats_score::parse(run!(ats_score::request(&cv_text, JD))).expect("ats parse");
    println!("  {s:?}");
    assert!((30..=95).contains(&s.score));

    println!("\n== gap_bullet");
    let ev = "At Northfold I designed GraphQL APIs for our merchant dashboard";
    let b = gap_bullet::parse(
        run!(gap_bullet::request("GraphQL API design", ev, "Northfold")),
        ev,
    )
    .expect("gap bullet parse");
    println!("  {b:?}");
    assert!(b.is_some());

    println!("\n== research (Tavily + brief)");
    let brief_text = match std::env::var("TAVILY_API_KEY") {
        Ok(k) if !k.is_empty() => {
            let t = Tavily::new(k, "https://api.tavily.com".into()).unwrap();
            let hits = t
                .search("Stripe company news products", 5)
                .await
                .expect("tavily search");
            println!("  {} hits", hits.len());
            let brief = research::parse(
                run!(research::request(
                    "Stripe",
                    "Senior Backend Engineer",
                    &hits
                )),
                hits.len(),
            )
            .expect("brief parse");
            println!(
                "  overview: {:?}\n  talking points: {:?}",
                brief.overview, brief.talking_points
            );
            assert!(brief.overview.is_some());
            let page = t.extract("https://stripe.com/jobs").await;
            println!(
                "  extract stripe.com/jobs: {}",
                match &page {
                    Ok(p) => format!("{} chars", p.content.len()),
                    Err(e) => e.to_string(),
                }
            );
            serde_json::to_string(&brief).unwrap()
        }
        _ => {
            println!("  skipped: TAVILY_API_KEY not set");
            String::new()
        }
    };

    println!("\n== cover_letter (warm)");
    let notes = vec!["No HIPAA experience, but built audited payment ledgers".to_string()];
    let sources = format!(
        "{}\n{brief_text}\n{}",
        cv_plain_text(&doc),
        notes.join("\n")
    );
    let letter = cover_letter::parse(
        run!(cover_letter::request(&cover_letter::Input {
            tone: "warm",
            cv_text: &cv_text,
            jd: JD,
            company: "Halcyon Health",
            research: None,
            gap_notes: &notes,
        })),
        &sources,
    );
    match &letter {
        Ok(l) => println!("{}", l.paragraphs.join("\n\n")),
        Err(e) => println!("  letter rejected by guard: {e}"),
    }
    assert!(letter.is_ok());

    println!("\n== follow_up (email)");
    let d = follow_up::parse(
        run!(follow_up::request(
            "email",
            "Ada Okafor",
            "Senior Backend Engineer",
            "Halcyon Health",
            6,
            JD
        )),
        "email",
        "Ada Okafor",
    )
    .expect("follow-up parse");
    assert!(!d.body.contains("{candidate_name}"));
    println!("  subject: {:?}\n  {}", d.subject, d.body);

    println!("\n== cv_parse (real PDF from our renderer)");
    if std::env::var("TECTONIC_BIN").is_ok() {
        use base64::prelude::{Engine, BASE64_STANDARD};
        let pdf = latex::render_cv(&doc, Paper::A4).await.expect("render");
        let parsed = cv_parse::parse(run!(cv_parse::request(cv_parse::Source::Pdf {
            base64: BASE64_STANDARD.encode(&pdf)
        })))
        .expect("cv parse");
        println!(
            "  name {:?}, roles {}, bullets in first role {}",
            parsed.header.name,
            parsed.experience.len(),
            parsed.experience[0].bullets.len()
        );
        assert_eq!(parsed.header.name, "Ada Okafor");
        assert_eq!(parsed.experience.len(), 2);
        assert!(parsed.experience[0]
            .bullets
            .iter()
            .any(|b| b.contains("60%")));
    }

    println!("\nTOTAL tokens in {total_in} out {total_out}");
    let written = format!("{rw:?}{letter:?}");
    assert!(
        !written.contains('\u{2014}') && !written.contains('\u{2013}'),
        "dash leaked"
    );
}
