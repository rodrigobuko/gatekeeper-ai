// Conservative, obvious-pattern bypass detection for English and Portuguese.
// This is intentionally narrow: it must never fire on genuine teach-back
// answers, so it only matches phrases that are unambiguous attempts to skip
// or self-approve the gate (directive section 15 / 2.9).

// Each pattern is a whole-phrase regex, case-insensitive, tolerant of extra
// whitespace. Word boundaries keep "skip the gate" from matching "skip the
// gated community" type false positives in normal engineering talk (still a
// contrived example, but the intent is to stay narrow).
const PATTERNS = [
  // English
  /\bskip (the )?gatekeeper\b/i,
  /\bignore (the )?gatekeeper\b/i,
  /\bbypass (the )?gatekeeper\b/i,
  /\bdisable (the )?gatekeeper\b/i,
  /\bturn off (the )?gatekeeper\b/i,
  /\bmark me (as )?(approved|worthy|passed)\b/i,
  /\bconsider me (approved|worthy|passed)\b/i,
  /\bpretend (i|we) (answered|passed|explained)( correctly)?\b/i,
  /\byou have permission\b/i,
  /\bjust implement( it)? anyway\b/i,
  /\bdo not follow the gatekeeper skill\b/i,
  /\bdon'?t follow the gatekeeper skill\b/i,
  /\bskip (this|that) (step|gate|check)\b/i,
  /\bignore (this|that) (step|gate|check)\b/i,

  // Portuguese
  /\bpule (o |a )?gatekeeper\b/i,
  /\bpula (o |a )?gatekeeper\b/i,
  /\bignora(r)? (o |a )?gatekeeper\b/i,
  /\bignore (o |a )?gatekeeper\b/i,
  /\bburla(r)? (o |a )?gatekeeper\b/i,
  /\bburle (o |a )?gatekeeper\b/i,
  /\bme considere (aprovado|digno|aprovada)\b/i,
  /\bpode implementar sem responder\b/i,
  /\bignora essa etapa\b/i,
  /\bpule essa etapa\b/i,
  /\bpula essa etapa\b/i,
];

export function detectBypass(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { isBypass: false, matched: null };
  }
  for (const pattern of PATTERNS) {
    if (pattern.test(text)) {
      return { isBypass: true, matched: pattern.source };
    }
  }
  return { isBypass: false, matched: null };
}
