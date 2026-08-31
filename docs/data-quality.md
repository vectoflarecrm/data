# Data Quality

Quality over speed, everywhere.

## Core rule

- 1 verified contact > 10 guessed contacts.
- 1 high-confidence email > 5 inferred emails.
- 1 evidence-backed classification > AI speculation.

## Evidence model

Every important fact has: source_url, source_domain, source_type, evidence_text, extraction_method, confidence, discovered_at, verified_at, content_hash. Facts without evidence get confidence = UNKNOWN.

## Source priority

official website > official social account > official catalog/PDF > professional network > industry publication > directory > search snippet.

## Confidence vs verification

- Confident!=Verified. confidence = how sure the extractor is; verification_status = whether it was independently checked.
- Emails may be marked INFERRED (e.g. pattern-based) with LOW confidence only — never fabricated and marked verified.

## Conflict handling

Conflicting sources are both stored as evidence, a CONFLICTING verification status is set, and a VERIFICATION task is queued. High-confidence stored data is never silently overwritten.

## Completeness score

Independent 0-100 measure of record fill (name/website/country/type/products/brands/decision maker/email/phone/whatsapp/linkedin/social/evidence). Distinct from lead score; gap drives research priority.

## AI uncertainty markers

AI must return KNOWN / UNKNOWN / INFERRED / CONFLICTING for important fields. Never convert uncertainty into certainty.