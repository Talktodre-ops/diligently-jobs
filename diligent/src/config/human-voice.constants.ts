// Anti-LLM-tell guidance to inject into any prompt that generates content
// the user will publish (CV bullets, summary, cover letter, follow-up
// messages). Designed to make output read as written by a sharp human and
// not produced by an AI.
//
// Most important rules first. Em dashes and the LLM-favorite verb list are
// the loudest tells in recruiter eyes in 2026: scanning a resume, a hiring
// manager will notice "—" in the first second and the brain flags "AI".
//
// Imported by:
//  - TAILOR_BULLETS_SYSTEM_PROMPT (job.function.ts)
//  - TAILOR_SUMMARY_SYSTEM_PROMPT (job.function.ts)
//  - COVER_LETTER_SYSTEM_PROMPT (cover-letter.function.ts)
//  - FOLLOWUP_SYSTEM_PROMPT (followup.function.ts)

export const HUMAN_VOICE_RULES = `HUMAN VOICE (the output must read as a sharp human wrote it, not an AI):

- NO em dashes (—) or en dashes (–) anywhere in the output. This is the #1 LLM tell in 2026 and the first thing a recruiter notices. Use commas, periods, parentheses, or the word "to" for ranges instead. If you find yourself wanting an em dash, rewrite the sentence.
- ASCII punctuation only. Straight quotes (" "), straight apostrophes ('). Never smart/curly quotes (“”‘’).
- AVOID these LLM-tell verbs and adjectives: "leverage", "spearhead", "orchestrate", "facilitate", "utilize", "demonstrate", "showcase", "highlight", "exemplify", "robust", "scalable", "innovative", "cutting-edge", "synergize", "streamline", "deliver" (only OK for products literally shipped), "drive" (only OK when literal e.g. "drove revenue +30%"), "elevate", "transform" (unless literal restructuring), "empower".
- Plain English over corporate-speak: "use" not "utilize", "to" not "in order to", "show" not "demonstrate", "help" not "facilitate", "led" not "spearheaded", "built" not "engineered" (unless it really was an engineered system).
- VARY sentence shape and length. Don't write every bullet (or sentence) in the same Verb-Object-Metric template. Mix in a shorter line, vary the verb position, occasionally lead with the metric.
- Don't tricolon every paragraph (the "X, Y, and Z" rhythm). Use the list-of-three once if at all, then break out of it.
- It's fine, even good, to skip the trailing period on bullet points the way humans often do.
- ALL monetary values in the output are in US dollars (USD, $). If the source material expresses a figure in Nigerian naira (NGN, ₦) or any other non-USD currency, convert it to a sensible USD equivalent at a roughly current rate and present it as USD only. Never emit "₦" or "NGN" or naira amounts. Pick believable, round-ish USD figures (e.g. "$120K ARR", "$4M annual revenue", "saved $85K/yr"), not over-precise conversions.`;
