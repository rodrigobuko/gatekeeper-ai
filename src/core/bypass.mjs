// Developer-response classification (hardening P0.5).
//
// The original v0.1 only distinguished "bypass" vs "everything else", which
// meant a pure help request ("I don't understand this, can you explain?")
// mechanically satisfied `latestResponseEligibleForGrant`, and Gatekeeper's
// only defense against "assistance counted as an answer" was the model
// choosing not to call `grant`. That is not a mechanical guarantee.
//
// This module is intentionally conservative and intentionally NOT a
// semantic grader: it only tells the engine whether a message is one of a
// few obvious *non-answer* shapes. Claude still evaluates whether a real
// answer is actually correct (`gatekeeper reject`/`grant`); this classifier
// only decides whether a message is even a *candidate* to be graded.
//
// Categories:
//   bypass              - an explicit attempt to skip/self-approve the gate
//   passive_approval    - "looks good", "go ahead", "continue", etc.
//   help_request        - "I don't understand", "can you explain", etc.
//   teachback_candidate - the only category eligible for grant
//   other               - short/ambiguous, not a recognized non-answer
//                         shape but also not substantive enough to grade;
//                         conservative default, never eligible
//
// A message that mixes a question with a real explanation is common and
// intentional ("I wasn't sure why X, but here's what I now think happens:
// ..."). Rather than trying to parse that split, this module uses length
// as the discriminator: passive-approval and help-request phrases are only
// classified as such when they dominate a SHORT message. A longer message
// — even one that opens with a question — falls through to
// teachback_candidate, where Claude's own judgment (not this classifier)
// decides whether it actually demonstrates understanding.

const PASSIVE_APPROVAL_MAX_WORDS = 8;
const HELP_REQUEST_MAX_WORDS = 25;
const MIN_SUBSTANTIVE_WORDS = 6;

// Each pattern is a whole-phrase regex, case-insensitive, tolerant of extra
// whitespace. See bypass detection design note in the original directive
// (section 15 / 2.9) — this list is unchanged from v0.1.
const BYPASS_PATTERNS = [
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

const PASSIVE_APPROVAL_PATTERNS = [
  /\blooks good\b/i,
  /\bgo ahead\b/i,
  /\bsounds good\b/i,
  /\blgtm\b/i,
  /\bjust do it\b/i,
  /\bship it\b/i,
  /^\s*continue\s*[.!]?\s*$/i,
  /^\s*approved\s*[.!]?\s*$/i,
  /\bokay,? implement it\b/i,
  /\bok,? implement it\b/i,
  // Portuguese
  /\bpode seguir\b/i,
  /\bpode implementar\b/i,
  /\bt[áa] bom\b/i,
  /^\s*segue\s*[.!]?\s*$/i,
  /\bmanda ver\b/i,
];

const HELP_REQUEST_PATTERNS = [
  /\bi don'?t (fully )?understand\b/i,
  /\bcan you explain\b/i,
  /\bcould you explain\b/i,
  /\bwhy do we need\b/i,
  /\bwhy are we\b/i,
  /\bwhy would\b/i,
  /\bshow me\b/i,
  /\bwalk me through\b/i,
  /\bwhat does this mean\b/i,
  /\bwhat do you mean\b/i,
  // Portuguese
  /\bn[ãa]o entendi\b/i,
  /\bpode explicar\b/i,
  /\bpor que precisamos\b/i,
  /\bme mostra\b/i,
];

function wordCount(text) {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}

export function classifyResponse(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { classification: 'other', matched: null };
  }

  for (const pattern of BYPASS_PATTERNS) {
    if (pattern.test(text)) return { classification: 'bypass', matched: pattern.source };
  }

  const words = wordCount(text);

  if (words <= PASSIVE_APPROVAL_MAX_WORDS) {
    for (const pattern of PASSIVE_APPROVAL_PATTERNS) {
      if (pattern.test(text)) return { classification: 'passive_approval', matched: pattern.source };
    }
  }

  if (words <= HELP_REQUEST_MAX_WORDS) {
    for (const pattern of HELP_REQUEST_PATTERNS) {
      if (pattern.test(text)) return { classification: 'help_request', matched: pattern.source };
    }
  }

  if (words < MIN_SUBSTANTIVE_WORDS) {
    return { classification: 'other', matched: null };
  }

  return { classification: 'teachback_candidate', matched: null };
}

// Kept for callers that only care about the sharpest signal (an explicit
// bypass attempt), and for backward compatibility with earlier v0.1 code.
export function detectBypass(text) {
  const { classification, matched } = classifyResponse(text);
  return { isBypass: classification === 'bypass', matched: classification === 'bypass' ? matched : null };
}
