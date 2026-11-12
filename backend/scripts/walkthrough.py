"""End-to-end walk of the hosted backend through every screen, against the
local dev server started by scripts/dev-local.sh (real Claude and Tavily,
local Postgres and S3 emulator). Spends a few cents of AI per run.

    scripts/dev-local.sh > /tmp/diligently-dev.log 2>&1 &
    DEV_SERVER_LOG=/tmp/diligently-dev.log python3 scripts/walkthrough.py

Email links are read from the server log (the logging mailer). Uses fixed
test emails, so start from a fresh database (DEV_RESET=1) each run.
"""
import http.cookiejar
import os
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8787"
ORIGIN = "http://localhost:5173"
LOG = os.environ.get("DEV_SERVER_LOG", "/tmp/diligently-dev.log")
PW = "walkthrough passphrase 2026"
results = []


class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method, path, body=None, raw=None, ctype="application/json"):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(BASE + path, data=data, method=method)
        req.add_header("origin", ORIGIN)
        if data is not None:
            req.add_header("content-type", ctype)
        try:
            with self.op.open(req, timeout=180) as r:
                txt = r.read()
                return r.status, (json.loads(txt) if txt and r.headers.get("content-type", "").startswith("application/json") else txt)
        except urllib.error.HTTPError as e:
            txt = e.read()
            try:
                return e.code, json.loads(txt)
            except Exception:
                return e.code, txt


def check(name, ok, detail=""):
    results.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)
    if not ok:
        print("  stopping: " + name)
        summary()
        sys.exit(1)


def summary():
    p = sum(1 for _, ok in results if ok)
    print(f"\n{p}/{len(results)} checks passed")


def log_token(email, path):
    for _ in range(20):
        text = re.sub(r"\x1b\[[0-9;]*m", "", open(LOG).read())
        m = re.findall(re.escape(ORIGIN + path) + r"\?token=([A-Za-z0-9_-]{43})", text)
        if m:
            return m[-1]
        time.sleep(0.5)
    raise SystemExit("no token in log for " + email)


def poll_job(c, job_id, label, limit=240):
    t0 = time.time()
    last = None
    while time.time() - t0 < limit:
        s, j = c.call("GET", f"/v1/jobs/{job_id}")
        prog = j.get("progress")
        if prog and prog != last:
            line = "  ".join(f"{p['key']}={p['status']}" for p in prog)
            print(f"    {time.time()-t0:5.1f}s  {line}", flush=True)
            last = prog
        if j["status"] in ("done", "failed"):
            return j, time.time() - t0
        time.sleep(1)
    return {"status": "timeout"}, time.time() - t0


def signup_verified(email):
    c = Client()
    s, b = c.call("POST", "/v1/auth/signup", {"email": email, "password": PW})
    check(f"sign up {email}", s == 201, str(s))
    tok = log_token(email, "/verify-email")
    s, _ = c.call("POST", "/v1/auth/verify", {"token": tok})
    check("verify email from the logged link", s == 200)
    return c


SAMPLE_CV = {
    "header": {"name": "Ada Okafor", "title": "Senior Backend Engineer", "email": "ada.okafor@example.com",
               "linkedin": {"url": "https://linkedin.com/in/ada-okafor-example", "display": "linkedin.com/in/ada-okafor-example"}},
    "summary": "Backend engineer with 7 years building payment and ledger systems in Go and Rust.",
    "experience": [
        {"role": "Senior Backend Engineer", "company": "Northfold", "location": "Lagos", "start": "Mar 2021", "end": "Present",
         "bullets": ["Cut ledger reconciliation time by 60% by moving batch jobs to Kafka consumers in Go",
                     "Designed the Postgres partitioning scheme for 400M payment rows",
                     "Led a 4-person on-call rotation and wrote the incident runbooks"]},
        {"role": "Backend Engineer", "company": "Quarry Labs", "location": "Remote", "start": "Jan 2018", "end": "Feb 2021",
         "bullets": ["Built the billing API in Rust used by 30 merchant integrations",
                     "Ran Terraform for 3 AWS accounts"]},
        {"role": "Software Engineer", "company": "Kestrel", "start": "", "end": "",
         "bullets": ["Shipped the first public REST API for partner banks"]},
    ],
    "education": [{"institution": "University of Lagos", "degree": "B.Sc. Computer Science", "start": "2011", "end": "2015"}],
    "skills": [{"label": "Languages", "items": ["Go", "Rust", "SQL", "Python"]},
               {"label": "Infrastructure", "items": ["Postgres", "Kafka", "Kubernetes", "Terraform", "AWS"]}],
    "projects": [],
}

JD = """Senior Backend Engineer, Payments Infrastructure (sample posting written for testing)
Stripe, Remote (Europe, Middle East and Africa)

Stripe builds economic infrastructure for the internet. The Payments Infrastructure team owns the systems that move money between businesses, banks and card networks, reliably and at very high volume.

What you will do
- Design and run backend services that process and reconcile payment events
- Improve the reliability of high-throughput event pipelines
- Own production systems end to end, including on-call

What we look for
- 6+ years building backend services in Go, Rust or Java
- Deep experience with PostgreSQL or another relational database at scale
- Event streaming with Kafka or similar
- Designing public APIs used by external developers
- Experience with PCI DSS or other regulated financial data

Nice to have: Kubernetes, Terraform, experience with card networks."""


def main():
    # A throwaway account produces a real CV PDF for the upload step.
    maker = signup_verified("pdfmaker@example.com")
    s, b = maker.call("PUT", "/v1/cv/master", {"doc": SAMPLE_CV})
    check("save a master CV (PDF maker)", s == 200)
    s, b = maker.call("POST", f"/v1/cv-versions/{b['cv']['id']}/render", {})
    j, t = poll_job(maker, b["job_id"], "render")
    check("render the sample CV to PDF", j["status"] == "done", f"{t:.1f}s")
    s, f = maker.call("POST", "/v1/blobs/presign-download", {"key": j["result"]["pdf_key"]})
    pdf = urllib.request.urlopen(f["url"]).read()
    check("download the PDF through a presigned link", pdf.startswith(b"%PDF-"), f"{len(pdf)} bytes")

    # The main user.
    c = signup_verified("ada.walkthrough@example.com")
    boundary = "walkboundary7MA4YWxk"
    form = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"Ada CV.pdf\"\r\n"
            f"Content-Type: application/pdf\r\n\r\n").encode() + pdf + f"\r\n--{boundary}--\r\n".encode()
    t0 = time.time()
    s, up = c.call("POST", "/v1/cv/upload", raw=form, ctype=f"multipart/form-data; boundary={boundary}")
    check("upload the CV PDF", s == 202, str(s))
    uid = up["upload"]["id"]
    while True:
        s, u = c.call("GET", f"/v1/cv/uploads/{uid}")
        if u["upload"]["status"] in ("done", "failed"):
            break
        time.sleep(1)
    check("Claude reads the uploaded PDF", u["upload"]["status"] == "done", f"{time.time()-t0:.1f}s, {u['upload'].get('error')}")
    s, m = c.call("GET", "/v1/cv/master")
    doc = m["cv"]["doc"]
    check("parsed CV keeps name, roles and the 60% bullet",
          doc["header"]["name"] == "Ada Okafor" and len(doc["experience"]) == 3
          and any("60%" in b for b in doc["experience"][0]["bullets"]),
          f"{len(doc['experience'])} roles")
    check("Check screen flags Kestrel's missing dates",
          any("Kestrel" in i["message"] for i in m["cv"]["issues"]), json.dumps(m["cv"]["issues"])[:160])
    s, p = c.call("GET", "/v1/profile")
    check("onboarding moved to check, name prefilled",
          p["profile"]["onboarding_step"] == "check" and p["profile"]["full_name"] == "Ada Okafor")
    s, p = c.call("PATCH", "/v1/profile", {"target_roles": ["Backend Engineer", "Platform Engineer"],
                                            "work_settings": ["remote"], "paper_size": "a4", "onboarding_step": "done"})
    check("set targets and finish onboarding", s == 200)

    # New job and Running.
    s, st = c.call("POST", "/v1/applications/start", {"jd_text": JD, "research": True, "letter": True})
    check("start an application from pasted text", s == 202, str(s))
    app_id = st["application_id"]
    print("  Running screen:")
    j, t = poll_job(c, st["job_id"], "pipeline", limit=300)
    check("pipeline finishes all five steps", j["status"] == "done" and all(p["status"] == "done" for p in j["progress"]),
          f"{t:.1f}s")

    s, b = c.call("GET", f"/v1/applications/{app_id}/brief")
    sc = b["score"]
    check("Workspace brief", s == 200 and b["application"]["company"],
          f"{b['application']['company']} / {b['application']['role']}; score before {sc['before']} projected {sc['projected']}; "
          f"{b['rewrites']['total']} rewrites, {b['gaps']['missing']} missing gaps, research {bool(b['research'])}, letter {b['letter']}")

    # Review.
    s, rw = c.call("GET", f"/v1/applications/{app_id}/rewrites")
    rws = rw["rewrites"]
    print("  Rewrites proposed:")
    for r in rws:
        print(f"    {r['bullet_id']}: {r['original']}\n        -> {r['rewrite']}\n        why: {r['why']} (needs_number={r['needs_number']})")
    check("at least two rewrites proposed", len(rws) >= 2, str(len(rws)))
    s, d = c.call("PATCH", f"/v1/rewrites/{rws[0]['id']}", {"action": "accept"})
    check("accept a rewrite; score moves", s == 200, f"current {d['score']['current']}")
    s, d = c.call("PATCH", f"/v1/rewrites/{rws[1]['id']}", {"action": "edit", "text": rws[1]["original"] + " (my edit)"})
    check("edit a rewrite", s == 200 and d["rewrite"]["status"] == "edited")
    for r in rws[2:]:
        c.call("PATCH", f"/v1/rewrites/{r['id']}", {"action": "keep"})
    if rw["summary"]:
        print(f"  Summary proposed: {rw['summary']['proposed']}")
        s, d = c.call("PATCH", f"/v1/applications/{app_id}/summary", {"action": "accept"})
        check("accept the summary", s == 200, f"current {d['score']['current']}, pending {d['score']['pending']}")

    # Gaps.
    s, g = c.call("GET", f"/v1/applications/{app_id}/gaps")
    print("  Gaps:")
    for x in g["gaps"]:
        print(f"    {x['status']:8} {x['requirement']}  ask: {x['ask']}")
    open_gaps = [x for x in g["gaps"] if x["status"] != "covered"]
    check("gaps listed with questions", len(open_gaps) >= 1 and all(x["ask"] for x in open_gaps))
    api_gap = next((x for x in open_gaps if "api" in x["requirement"].lower()), open_gaps[0])
    s, a = c.call("POST", f"/v1/gaps/{api_gap['id']}/answer",
                  {"have": True, "text": "At Northfold I designed the public REST API that partner banks used to settle payouts", "entry": 0})
    check("answer 'I have this'", s == 200, f"suggested: {a['gap']['suggested_bullet']}")
    if a["gap"]["suggested_bullet"]:
        s, _ = c.call("PATCH", f"/v1/gaps/{api_gap['id']}", {"bullet": "accept"})
        check("accept the suggested bullet", s == 200)
    other = next((x for x in open_gaps if x["id"] != api_gap["id"]), None)
    if other:
        s, _ = c.call("POST", f"/v1/gaps/{other['id']}/answer", {"have": False})
        check(f"answer 'I don't' for {other['requirement']}", s == 200)

    s, cv = c.call("GET", f"/v1/applications/{app_id}/cv")
    first = cv["doc"]["experience"][0]["bullets"]
    check("tailored CV reflects the decisions", rws[0]["rewrite"] in json.dumps(cv["doc"]) and any("(my edit)" in b for e in cv["doc"]["experience"] for b in e["bullets"]),
          f"{len(first)} bullets in the first role")

    # Research and letter.
    s, r = c.call("GET", f"/v1/applications/{app_id}/research")
    check("research brief with sources", s == 200 and r["brief"].get("overview"), (r["brief"].get("overview") or "")[:120])
    t0 = time.time()
    s, l = c.call("POST", f"/v1/applications/{app_id}/cover-letters/regenerate", {"tone": "warm"})
    check("regenerate the letter in a warm tone", s == 200, f"{time.time()-t0:.1f}s, {len(l.get('body','').split())} words" if s == 200 else str(l))
    if s == 200:
        print("  Letter (warm):\n" + "\n".join("    " + p for p in l["body"].split("\n\n")))
        check("letter has no em or en dashes", "\u2014" not in l["body"] and "\u2013" not in l["body"])

    # Send.
    s, rr = c.call("POST", f"/v1/applications/{app_id}/render", {"include_letter": True})
    check("render CV and letter", s == 202)
    for jid in [rr["cv_job_id"], rr["letter_job_id"]]:
        j, t = poll_job(c, jid, "render")
        check("render job done", j["status"] == "done", f"{t:.1f}s")
    s, files = c.call("GET", f"/v1/applications/{app_id}/files")
    for kind, url in [("CV PDF", files["cv"]["pdf_url"]), ("CV DOCX", files["cv"]["docx_url"]), ("letter PDF", files["letter"]["pdf_url"])]:
        resp = urllib.request.urlopen(url)
        body = resp.read()
        check(f"download {kind}", len(body) > 1000, f"{len(body)} bytes, {resp.headers.get('content-disposition')}")
    check("rendered CV is up to date", files["cv"]["up_to_date"] is True)

    s, ap = c.call("POST", f"/v1/applications/{app_id}/applied", {"reminder_days": 5})
    check("mark applied with a 5-day reminder", s == 200, ap["reminder"]["due_at"])
    subprocess.run(["docker", "exec", "diligently-test-pg", "psql", "-U", "diligently", "-d", "diligently_dev", "-qc",
                    "update reminders set due_at = now() - interval '1 minute'"], check=True)
    print("  waiting for the worker's reminder sweep (runs every 60 s)...", flush=True)
    t0 = time.time()
    while time.time() - t0 < 90:
        s, fu = c.call("GET", f"/v1/applications/{app_id}/follow-ups")
        if fu["reminder"] and fu["reminder"]["status"] == "sent":
            break
        time.sleep(3)
    check("reminder sent by the worker with a drafted follow-up", fu["reminder"]["status"] == "sent" and fu["drafts"]["email"],
          f"{time.time()-t0:.0f}s")
    print("  Follow-up draft:\n    subject: " + str(fu["drafts"]["email"]["subject"]) + "\n" + "\n".join("    " + x for x in fu["drafts"]["email"]["body"].split("\n")))
    logtext = open(LOG).read()
    check("reminder email logged", "Follow up with" in logtext)

    s, h = c.call("GET", "/v1/home")
    print("  Home: " + json.dumps({"first_name": h["first_name"], "needs_you": [x["text"] for x in h["needs_you"]],
                                    "this_week": [x["text"] for x in h["this_week"]]}))
    check("Home shows the follow-up card", any(x["type"] == "follow_up" for x in h["needs_you"]))

    s, ex = c.call("GET", "/v1/account/export")
    check("export my data", s == 200 and isinstance(ex, (bytes, dict)), f"{len(ex) if isinstance(ex, bytes) else 'json'}")
    s, u = c.call("GET", "/v1/usage")
    check("usage counter", u["applications_this_month"] == 1, json.dumps(u))
    cost = subprocess.run(["docker", "exec", "diligently-test-pg", "psql", "-U", "diligently", "-d", "diligently_dev", "-tAc",
                           "select count(*), sum(input_tokens), sum(output_tokens), sum(cost_micros) from ai_usage where application_id = '" + app_id + "'"],
                          capture_output=True, text=True).stdout.strip()
    n, tin, tout, micros = cost.split("|")
    print(f"  AI for this application: {n} calls, {tin} in / {tout} out tokens, ${int(micros)/1e6:.3f}")

    s, _ = maker.call("DELETE", "/v1/account", {"password": PW})
    check("delete the throwaway account", s == 204)
    summary()


main()
