// ─── host-prompt-slim: segment classification rules ─────────────────────────
// Zero-dependency, rule-driven prompt segmentation for host-side system prompts
// (base_instructions / instructions_template / system_prompt / ...).
//
// Safety model:
//   - KEEP  : runtime protocols, security boundaries, tool/skill contracts.
//             Content survives verbatim (only harmless whitespace normalization).
//   - TRIM  : prose-heavy guidance. Sentences carrying rule verbs (must/should/
//             never/... ) are kept; pure description/fluff sentences are dropped.
//   - DROP  : pure persona/voice sections with no operational content.
//
// Classification is conservative: any segment that matches nothing falls back
// to KEEP. The `slim` command always requires a human gate (--dry-run preview
// unless --yes is passed explicitly).

"use strict";

// Section titles (case-insensitive, matched against the normalized heading
// text of each `#` / `##` / `###` segment) that must be preserved verbatim.
const KEEP_TITLE = [
  /^working with the user/,
  /^intermediate commentary/,
  /^intermediary updates/,
  /^final answer/,
  /^formatting rules/,
  /^visualizations/,
  /^rules for getting work done/,
  /^file editing constraints/,
  /^editing constraints/,
  /^autonomy/,
  /^engineering judgment/,
  /^special user requests/,
  /^using skills/,
  /^how to use skills/,
  /^safety/,
  /^security/,
  /^privacy/,
];

// Sections that are trimmed sentence-wise (rule sentences kept).
const TRIM_TITLE = [
  /^writing style/,
  /^technical communication/,
  /^documentation/,
  /^general/,
  /^background/,
  /^context/,
  /^frontend guidance/,
  /^build with empathy/,
  /^design instructions/,
  /^design guidance/,
];

// Sections treated as pure persona/voice and removed entirely.
const DROP_TITLE = [
  /^personality/,
  /^voice/,
  /^tone/,
];

// Rule verbs: presence of any of these marks a sentence as operational.
const RULE_VERBS = /\b(must|should|never|always|do not|don'?t|avoid|use|prefer|require|block|stop|when|if|before|after|unless|only|keep|ensure|may|can|cannot|must not|need|mustn'?t)\b/i;

// Sentence-level trimming: keep sentences that carry a rule verb or contain
// >= 2 numbers/backticks/code tokens (technical detail), drop the rest.
function isRuleSentence(sentence) {
  if (RULE_VERBS.test(sentence)) return true;
  const codeish = (sentence.match(/`/g) || []).length;
  const numeric = (sentence.match(/\d/g) || []).length;
  return codeish >= 1 || numeric >= 3;
}

// Split text into sentences for TRIM segments. Splits on ASCII sentence
// terminators followed by whitespace, without breaking "e.g." / "i.e." /
// "vs." / "etc." / decimals.
function splitSentences(text) {
  if (!text) return [];
  const tokens = text.split(/(?<=[.!?])(?=\s+[A-Z0-9"`(])/);
  return tokens.map((t) => t.trim()).filter(Boolean);
}

// Classify one segment by its normalized heading text.
function classifyTitle(heading) {
  const h = (heading || "").toLowerCase().trim();
  if (!h) return "keep"; // preamble / untitled content
  for (const re of DROP_TITLE) if (re.test(h)) return "drop";
  for (const re of KEEP_TITLE) if (re.test(h)) return "keep";
  for (const re of TRIM_TITLE) if (re.test(h)) return "trim";
  return "keep"; // conservative fallback
}

// Apply a classification to raw segment body text.
function transformBody(action, body, heading) {
  if (action === "drop") return "";
  if (action === "trim") {
    const kept = splitSentences(body).filter(isRuleSentence);
    return kept.join(" ");
  }
  return body; // keep verbatim
}

module.exports = {
  KEEP_TITLE,
  TRIM_TITLE,
  DROP_TITLE,
  RULE_VERBS,
  classifyTitle,
  transformBody,
  splitSentences,
  isRuleSentence,
};
