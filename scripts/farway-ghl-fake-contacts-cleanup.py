"""
farway-ghl-fake-contacts-cleanup.py — Identifica e ripulisce contatti GHL fake
sul sub-account Farway (`JBuWIjzSNTS4MYPiWjen`).

Modalita':

  --mode scan       Discovery solo post-cutoff (2026-03-27). High-confidence (>=1
                    strong criterion). Output `fake-candidates-latest.csv|json`.

  --mode scan-all   Discovery su TUTTA la base GHL. Produce DUE file:
                    - `fake-candidates-latest.csv|json` (high confidence)
                    - `borderline-candidates-latest.csv|json` (weak signals,
                      richiede review umana)

  --mode delete     Cancella i contatti in `fake-candidates-latest.json`.
                    Richiede --i-understand-this-is-destructive.

Criteri STRONG (1 match -> fake confermato):
  C1  Nome alfanumerico random con >=3 case-switches dentro una parola >=8 char
  C2  Email con >=3 punti separatori nel local-part
  C3  Nome contiene keyword scam (bitcoin/payment/recovery/...) o URL
  C4  Dominio email in blacklist disposable/spam
  C5  Nome usa Unicode mathematical bold (𝐀-𝐳) o stilizzato

Criteri WEAK (2+ match -> borderline review):
  W1  Email local-part >=15 char con alphanumeric random (no vocali sensate)
  W2  Engagement zero: phone null + email null + solo tag default
  W3  firstName molto corto (1-2 char) o solo digit/punteggiatura
  W4  Email TLD esotico (.top .xyz .icu .click .country) senza altri segnali forti
  W5  firstName === lastName (duplicato sospetto)

Whitelist (mai candidato anche se criteri scattano):
  - Tag `cliente` o `cliente ricorrente` presente
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib import request, error, parse

ENV_FILE = Path(r"D:\Coding\Farway\farway-photo-app\.env.local")
OUT_DIR = Path(r"D:\Coding\Farway\farway-photo-app\_local")
API_BASE = "https://services.leadconnectorhq.com"
API_VERSION = "2021-07-28"
CUTOFF_DATE = "2026-03-27T00:00:00.000Z"
CUTOFF_DT = datetime(2026, 3, 27, tzinfo=timezone.utc)
CLEANUP_TAG = "fake-cleanup-2026-05"
WHITELIST_TAGS = {"cliente", "cliente ricorrente"}

SUSPICIOUS_DOMAINS = {
    "wailo.cloud", "wailo.cloudns.asia", "shopcobe.com", "ship79.com", "gxmail.top",
    "tempmail.com", "tempmail.org", "temp-mail.org", "temp-mail.io",
    "mailinator.com", "guerrillamail.com", "guerrillamail.info",
    "throwaway.com", "10minutemail.com", "yopmail.com", "yopmail.net",
    "sharklasers.com", "trashmail.com", "trashmail.net", "maildrop.cc",
    "spam4.me", "getairmail.com", "fakeinbox.com", "dispostable.com",
    "moakt.com", "tempr.email", "emailondeck.com", "mintemail.com",
}
# TLD esotici usati dai bot. NON in blacklist hard: solo segnale debole W4.
EXOTIC_TLDS = {".top", ".xyz", ".icu", ".click", ".country", ".zip", ".mov",
               ".tk", ".ml", ".ga", ".cf", ".gq", ".rest", ".loan", ".work"}

NAME_KEYWORDS = {
    "payment", "pagament", "bonifico", "wire", "transfer", "transazione",
    "withdraw", "deposit", "deposito", "bitcoin", "btc", "crypto", "loan",
    "credit", "winner", "prize", "claim", "refund", "compensation",
    "recovery", "blockchain", "ether", "bch", "eth ", "usdt",
}
URL_FRAGMENTS = ("http://", "https://", "telegra.ph", ".ph?", "bit.ly", "t.me/")


def load_env() -> tuple[str, str]:
    if not ENV_FILE.exists():
        sys.exit(f"ERRORE: env.local non trovato in {ENV_FILE}")
    token = None
    loc = None
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        if line.startswith("GHL_TOKEN_SUBACCOUNT_FARWAY="):
            token = line.split("=", 1)[1].strip().strip('"').strip("'")
        elif line.startswith("GHL_ID_LOCATION_FARWAY="):
            loc = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not token or not loc:
        sys.exit("ERRORE: token/location non trovati in env.local")
    return token, loc


def http_request(method: str, url: str, token: str, body: dict | None = None, retries: int = 3) -> tuple[int, dict | None]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "Authorization": f"Bearer {token}",
        "Version": API_VERSION,
        "Accept": "application/json",
        "User-Agent": "futuria-farway-cleanup/1.0 (+contact: fabrizio@futuriamarketing.com)",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = request.Request(url, data=data, method=method, headers=headers)
    for attempt in range(retries):
        try:
            with request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                if not raw:
                    return resp.status, None
                return resp.status, json.loads(raw.decode("utf-8"))
        except error.HTTPError as e:
            status = e.code
            raw = e.read().decode("utf-8", errors="replace")
            if status in (429, 502, 503, 504) and attempt < retries - 1:
                wait = 2 ** attempt
                sys.stderr.write(f"  retry {attempt+1}/{retries} dopo {wait}s (HTTP {status})\n")
                time.sleep(wait)
                continue
            try:
                return status, json.loads(raw)
            except Exception:
                return status, {"_raw": raw}
        except (error.URLError, TimeoutError) as e:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
                continue
            return 0, {"_error": str(e)}
    return 0, None


def fetch_contacts(token: str, location_id: str, scan_all: bool = False) -> list[dict]:
    """Pagina /contacts/ in ordine DESC per dateAdded. Se scan_all=False si ferma
    appena scende sotto il cutoff; se True scarica tutta la base."""
    out: list[dict] = []
    url = f"{API_BASE}/contacts/?{parse.urlencode({'locationId': location_id, 'limit': 100})}"
    page = 0
    while url:
        page += 1
        status, data = http_request("GET", url, token)
        if status != 200 or not data:
            sys.exit(f"ERRORE fetch pagina {page}: HTTP {status} body={data}")
        contacts = data.get("contacts", [])
        sys.stderr.write(f"  pagina {page}: {len(contacts)} contatti (cumulato {len(out) + len(contacts)})\n")
        stop = False
        for c in contacts:
            if scan_all:
                out.append(c)
                continue
            d = c.get("dateAdded")
            if not d:
                continue
            try:
                dt = datetime.fromisoformat(d.replace("Z", "+00:00"))
            except ValueError:
                continue
            if dt < CUTOFF_DT:
                stop = True
                break
            out.append(c)
        if stop:
            break
        meta = data.get("meta", {})
        url = meta.get("nextPageUrl")
        if not url:
            break
    return out


WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)


def looks_random_alphanumeric(name: str | None) -> bool:
    """C1: contiene UNA singola parola di >=8 char alpha con >=3 case-switches al
    suo interno (skip prima lettera, che può essere maiuscola legittimamente).

    Nomi reali tipo "Julia Elle", "Maria Teresa D'Angelo - Celebrity Stylist",
    "Gabriela Lecce Cliente Seventy" hanno parole brevi con prima maiuscola e
    resto lowercase: 0 switch interni. Stringhe bot tipo "EjCXKSoyFgapqjdjB"
    hanno molti switch dentro la stessa parola.
    """
    if not name:
        return False
    for w in WORD_RE.findall(name):
        if len(w) < 8:
            continue
        inner = w[1:]
        switches = sum(1 for a, b in zip(inner, inner[1:]) if a.islower() != b.islower())
        if switches >= 3:
            return True
    return False


DOTTED_LOCAL_RE = re.compile(r"^([^@]+)@")


def email_has_dotted_local(email: str | None) -> bool:
    """C2: local-part dell'email ha >=3 punti."""
    if not email:
        return False
    m = DOTTED_LOCAL_RE.match(email.strip())
    if not m:
        return False
    local = m.group(1)
    return local.count(".") >= 3


def has_emoji_or_keyword(name: str | None) -> bool:
    """C3: nome contiene keyword scam (bitcoin/payment/recovery/...) o URL.
    Emoji da sole NON sono trigger: nomi reali decorano con emoji (stylist con
    🎬👗, brand con 🩷, ecc.). Servono insieme a una keyword scam.
    """
    if not name:
        return False
    n = name.lower()
    if any(k in n for k in NAME_KEYWORDS):
        return True
    if any(frag in n for frag in URL_FRAGMENTS):
        return True
    return False


def suspicious_domain(email: str | None) -> bool:
    """C4: dominio in blacklist."""
    if not email or "@" not in email:
        return False
    domain = email.strip().rsplit("@", 1)[-1].lower()
    return domain in SUSPICIOUS_DOMAINS


def has_mathematical_unicode(name: str | None) -> bool:
    """C5: nome contiene caratteri Unicode mathematical bold/italic (𝐀-𝐳, 𝑨-𝒛).
    Quasi sempre usato da spam bot per evadere filtri di plain-text."""
    if not name:
        return False
    for c in name:
        code = ord(c)
        # Mathematical Alphanumeric Symbols block: U+1D400..U+1D7FF
        if 0x1D400 <= code <= 0x1D7FF:
            return True
    return False


# --- Weak signals (borderline review) ---


def email_random_local(email: str | None) -> bool:
    """W1: local-part >=15 char con pattern alphanumeric random.
    Heuristic: ratio consonanti consecutive >=3 OR mix case-switch >=3."""
    if not email or "@" not in email:
        return False
    local = email.split("@", 1)[0]
    if len(local) < 15:
        return False
    # Skip se ha caratteri di separazione strutturati (.- _)
    if local.count(".") >= 2 or local.count("-") >= 2 or local.count("_") >= 2:
        return False
    alpha = "".join(c for c in local if c.isalpha())
    if len(alpha) < 10:
        return False
    switches = sum(1 for a, b in zip(alpha, alpha[1:]) if a.islower() != b.islower())
    if switches >= 3:
        return True
    # Sequenze consonanti consecutive lunghe
    vowels = set("aeiouAEIOU")
    consec = 0
    max_consec = 0
    for c in alpha:
        if c not in vowels:
            consec += 1
            max_consec = max(max_consec, consec)
        else:
            consec = 0
    return max_consec >= 6


def engagement_zero(contact: dict) -> bool:
    """W2: nessun phone, nessuna email custom, tag solo default (newsletter|consenso|welcome).
    Da solo non basta — l'inbound newsletter senza acquisto e' normale per molti."""
    if contact.get("phone"):
        return False
    email = contact.get("email")
    tags = contact.get("tags") or []
    if not email:
        return False  # niente engagement, ma anche niente bot signal forte
    default_tags = {"newsletter", "consenso privacy", "welcome completata"}
    norm_tags = {t.lower().strip() for t in tags}
    extras = norm_tags - default_tags
    return len(extras) == 0


def short_or_punct_firstname(contact: dict) -> bool:
    """W3: firstName molto corto (1-2 alphabetic char) o solo digit/punteggiatura."""
    fn = (contact.get("firstNameRaw") or contact.get("firstName") or "").strip()
    if not fn:
        return False
    alpha = "".join(c for c in fn if c.isalpha())
    if len(alpha) <= 2:
        return True
    return False


def exotic_tld(email: str | None) -> bool:
    """W4: TLD esotico (.top .xyz .icu ecc)."""
    if not email or "@" not in email:
        return False
    domain = email.strip().rsplit("@", 1)[-1].lower()
    for tld in EXOTIC_TLDS:
        if domain.endswith(tld):
            return True
    return False


def same_first_last(contact: dict) -> bool:
    """W5: firstName === lastName (duplicato sospetto, es. \"john john\")."""
    fn = (contact.get("firstNameRaw") or contact.get("firstName") or "").strip().lower()
    ln = (contact.get("lastNameRaw") or contact.get("lastName") or "").strip().lower()
    if not fn or not ln:
        return False
    return fn == ln


def is_whitelisted(tags: list[str]) -> bool:
    if not tags:
        return False
    norm = {t.strip().lower() for t in tags if isinstance(t, str)}
    return bool(norm & WHITELIST_TAGS)


def classify(contact: dict) -> dict | None:
    """Ritorna dict con motivi se STRONG candidato, None se pulito o whitelisted."""
    tags = contact.get("tags") or []
    if is_whitelisted(tags):
        return None
    first = contact.get("firstNameRaw") or contact.get("firstName") or ""
    last = contact.get("lastNameRaw") or contact.get("lastName") or ""
    full = f"{first} {last}".strip()
    email = (contact.get("email") or "").strip()

    reasons = []
    if looks_random_alphanumeric(first) or looks_random_alphanumeric(last) or looks_random_alphanumeric(full):
        reasons.append("C1-random-name")
    if email_has_dotted_local(email):
        reasons.append("C2-dotted-email")
    if has_emoji_or_keyword(first) or has_emoji_or_keyword(last):
        reasons.append("C3-emoji-keyword")
    if suspicious_domain(email):
        reasons.append("C4-suspicious-domain")
    if has_mathematical_unicode(first) or has_mathematical_unicode(last):
        reasons.append("C5-math-unicode")

    if not reasons:
        return None
    return {
        "id": contact.get("id"),
        "firstName": first,
        "lastName": last,
        "email": email,
        "phone": contact.get("phone"),
        "dateAdded": contact.get("dateAdded"),
        "tags": tags,
        "source": contact.get("source"),
        "reasons": reasons,
    }


def classify_borderline(contact: dict) -> dict | None:
    """Ritorna dict se borderline (>=2 weak signals, no strong). None altrimenti."""
    tags = contact.get("tags") or []
    if is_whitelisted(tags):
        return None
    # Skip se gia' strong candidate
    if classify(contact) is not None:
        return None

    first = contact.get("firstNameRaw") or contact.get("firstName") or ""
    last = contact.get("lastNameRaw") or contact.get("lastName") or ""
    email = (contact.get("email") or "").strip()

    weak_reasons = []
    if email_random_local(email):
        weak_reasons.append("W1-random-email-local")
    if engagement_zero(contact):
        weak_reasons.append("W2-engagement-zero")
    if short_or_punct_firstname(contact):
        weak_reasons.append("W3-short-firstname")
    if exotic_tld(email):
        weak_reasons.append("W4-exotic-tld")
    if same_first_last(contact):
        weak_reasons.append("W5-same-first-last")

    if len(weak_reasons) < 2:
        return None
    return {
        "id": contact.get("id"),
        "firstName": first,
        "lastName": last,
        "email": email,
        "phone": contact.get("phone"),
        "dateAdded": contact.get("dateAdded"),
        "tags": tags,
        "source": contact.get("source"),
        "weak_reasons": weak_reasons,
        "score": len(weak_reasons),
    }


def cmd_scan(token: str, loc: str, out_dir: Path, scan_all: bool = False) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    scope = "TUTTA la base" if scan_all else f"dateAdded >= {CUTOFF_DATE}"
    sys.stderr.write(f"[scan] fetch contatti GHL {scope}\n")
    contacts = fetch_contacts(token, loc, scan_all=scan_all)
    sys.stderr.write(f"[scan] {len(contacts)} contatti totali\n")

    candidates: list[dict] = []
    borderline: list[dict] = []
    whitelisted_hits: list[dict] = []
    for c in contacts:
        tags = c.get("tags") or []
        if is_whitelisted(tags):
            tmp = dict(c)
            tmp["tags"] = []
            res = classify(tmp)
            if res:
                whitelisted_hits.append({
                    "id": c.get("id"),
                    "firstName": c.get("firstNameRaw") or c.get("firstName"),
                    "email": c.get("email"),
                    "dateAdded": c.get("dateAdded"),
                    "tags": tags,
                    "would_match": res["reasons"],
                })
            continue
        res = classify(c)
        if res:
            candidates.append(res)
            continue
        # Borderline solo se non gia' strong candidate
        if scan_all:
            bres = classify_borderline(c)
            if bres:
                borderline.append(bres)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    json_path = out_dir / "fake-candidates-latest.json"
    csv_path = out_dir / "fake-candidates-latest.csv"

    payload = {
        "scan_at": timestamp,
        "scope": scope,
        "total_contacts": len(contacts),
        "candidates_count": len(candidates),
        "borderline_count": len(borderline),
        "whitelisted_with_fake_pattern_count": len(whitelisted_hits),
        "candidates": candidates,
        "borderline": borderline,
        "whitelisted_with_fake_pattern": whitelisted_hits,
    }
    json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "firstName", "lastName", "email", "phone", "dateAdded", "tags", "reasons"])
        for c in candidates:
            w.writerow([
                c["id"], c["firstName"], c["lastName"], c["email"], c["phone"] or "",
                c["dateAdded"], "|".join(c["tags"]), "|".join(c["reasons"]),
            ])

    if scan_all and borderline:
        borderline.sort(key=lambda x: (-x["score"], x["dateAdded"]))
        bjson_path = out_dir / "borderline-candidates-latest.json"
        bcsv_path = out_dir / "borderline-candidates-latest.csv"
        bjson_path.write_text(json.dumps(
            {"scan_at": timestamp, "borderline": borderline},
            indent=2, ensure_ascii=False), encoding="utf-8")
        with bcsv_path.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["id", "score", "firstName", "lastName", "email", "phone",
                        "dateAdded", "tags", "weak_reasons"])
            for c in borderline:
                w.writerow([
                    c["id"], c["score"], c["firstName"], c["lastName"], c["email"],
                    c["phone"] or "", c["dateAdded"], "|".join(c["tags"]),
                    "|".join(c["weak_reasons"]),
                ])

    by_reason: dict[str, int] = {}
    for c in candidates:
        for r in c["reasons"]:
            by_reason[r] = by_reason.get(r, 0) + 1
    by_weak: dict[str, int] = {}
    for c in borderline:
        for r in c["weak_reasons"]:
            by_weak[r] = by_weak.get(r, 0) + 1

    print(f"\n[scan] OK — {len(contacts)} contatti totali, {len(candidates)} STRONG candidati, {len(borderline)} BORDERLINE, {len(whitelisted_hits)} match in whitelist")
    print(f"[scan] breakdown strong:")
    for r, n in sorted(by_reason.items()):
        print(f"   {r}: {n}")
    if scan_all:
        print(f"[scan] breakdown weak (borderline):")
        for r, n in sorted(by_weak.items()):
            print(f"   {r}: {n}")
    print(f"[scan] strong CSV: {csv_path}")
    print(f"[scan] strong JSON: {json_path}")
    if scan_all and borderline:
        print(f"[scan] borderline CSV: {out_dir / 'borderline-candidates-latest.csv'}")
        print(f"[scan] borderline JSON: {out_dir / 'borderline-candidates-latest.json'}")
    return 0


def cmd_tag(token: str, loc: str, out_dir: Path, confirm: bool) -> int:
    latest = out_dir / "fake-candidates-latest.json"
    if not latest.exists():
        sys.exit(f"ERRORE: nessuno scan precedente. Lancia prima --mode scan.")
    payload = json.loads(latest.read_text(encoding="utf-8"))
    candidates = payload.get("candidates", [])
    if not candidates:
        print("[tag] nessun candidato. Niente da fare.")
        return 0
    if not confirm:
        print(f"[tag] {len(candidates)} candidati. Rilancia con --confirm per applicare tag '{CLEANUP_TAG}'.")
        return 0
    print(f"[tag] applico tag '{CLEANUP_TAG}' a {len(candidates)} contatti")
    fails = 0
    for i, c in enumerate(candidates, 1):
        cid = c["id"]
        url = f"{API_BASE}/contacts/{cid}/tags"
        body = {"tags": [CLEANUP_TAG]}
        status, data = http_request("POST", url, token, body)
        if status not in (200, 201):
            fails += 1
            sys.stderr.write(f"  [{i}/{len(candidates)}] FAIL tag {cid} HTTP {status} body={data}\n")
        elif i % 25 == 0 or i == len(candidates):
            sys.stderr.write(f"  [{i}/{len(candidates)}] taggati ok\n")
    print(f"[tag] completato — {len(candidates) - fails} ok, {fails} falliti")
    return 1 if fails else 0


def cmd_delete(token: str, loc: str, out_dir: Path, confirm_destructive: bool) -> int:
    if not confirm_destructive:
        sys.exit("[delete] richiede --i-understand-this-is-destructive")
    latest = out_dir / "fake-candidates-latest.json"
    if not latest.exists():
        sys.exit("ERRORE: nessun JSON candidati. Lancia prima scan + tag.")
    payload = json.loads(latest.read_text(encoding="utf-8"))
    candidates = payload.get("candidates", [])
    if not candidates:
        print("[delete] nessun candidato. Niente da fare.")
        return 0
    print(f"[delete] cancello {len(candidates)} contatti")
    fails = 0
    for i, c in enumerate(candidates, 1):
        cid = c["id"]
        url = f"{API_BASE}/contacts/{cid}"
        status, data = http_request("DELETE", url, token)
        if status not in (200, 204):
            fails += 1
            sys.stderr.write(f"  [{i}/{len(candidates)}] FAIL delete {cid} HTTP {status} body={data}\n")
        elif i % 25 == 0 or i == len(candidates):
            sys.stderr.write(f"  [{i}/{len(candidates)}] cancellati ok\n")
    print(f"[delete] completato — {len(candidates) - fails} ok, {fails} falliti")
    return 1 if fails else 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--mode", choices=["scan", "scan-all", "tag", "delete"], required=True)
    p.add_argument("--confirm", action="store_true", help="Per --mode tag")
    p.add_argument("--i-understand-this-is-destructive", action="store_true", help="Per --mode delete")
    p.add_argument("--out-dir", type=Path, default=OUT_DIR)
    args = p.parse_args()

    token, loc = load_env()
    if args.mode == "scan":
        return cmd_scan(token, loc, args.out_dir, scan_all=False)
    if args.mode == "scan-all":
        return cmd_scan(token, loc, args.out_dir, scan_all=True)
    if args.mode == "tag":
        return cmd_tag(token, loc, args.out_dir, args.confirm)
    if args.mode == "delete":
        return cmd_delete(token, loc, args.out_dir, args.i_understand_this_is_destructive)
    return 1


if __name__ == "__main__":
    sys.exit(main())
