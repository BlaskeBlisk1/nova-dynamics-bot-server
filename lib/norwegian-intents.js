"use strict";

// Input is already folded to lowercase Norwegian search text. Remove the verb
// in "be om" / "kan jeg be", while retaining an explicit licence such as
// "Kan jeg be om kjøretime for klasse BE?".
function withoutRequestVerbBe(text) {
  return text.replace(/\bbe\s+om\b/g, "")
    .replace(/\b(?:kan|vil|skal|ma|a)\s+(?:(?:jeg|du|dere|vi)\s+)?be\b/g, "");
}

function assessmentStages(text) {
  const stages = new Set();
  if (/\btrinnvurdering\s+(?:trinn\s+)?(?:2|to)\b/.test(text)) stages.add(2);
  if (/\btrinnvurdering\s+(?:trinn\s+)?(?:3|tre)\b/.test(text)) stages.add(3);
  if (stages.size && /\b(?:(?:2|to)\s*(?:og|eller|\/)\s*(?:3|tre)|(?:3|tre)\s*(?:og|eller|\/)\s*(?:2|to))\b/.test(text)) {
    stages.add(2);
    stages.add(3);
  }
  return stages;
}

module.exports = { withoutRequestVerbBe, assessmentStages };
