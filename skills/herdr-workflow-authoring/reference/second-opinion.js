// Two independent reviewers inspect the same thing through different
// lenses, then a third call reconciles their verdicts.
//
//   herdr-dynamic-workflow '{"scriptPath":"skills/herdr-workflow-authoring/reference/second-opinion.js"}'

export const meta = {
  name: "second_opinion",
  description: "Two independent reviewers inspect the same diff; a third reconciles them",
  phases: [{ title: "Review" }, { title: "Reconcile" }],
};

const target = (args && args.target) || "HEAD~1..HEAD";

const finding = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["ship", "fix", "unsure"] },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "reasons"],
};

phase("Review");

// Same target, two independent lenses. Neither sees the other's answer.
const [correctness, maintainability] = await parallel(
  ["correctness", "maintainability"].map((lens) => () =>
    agent(`Review the diff in ${target} through the ${lens} lens. Is it safe to ship?`, {
      kind: "codex",
      label: `review:${lens}`,
      schema: finding,
    }),
  ),
);

// A dead agent returns null, so filter before using the results.
const reviews = [correctness, maintainability].filter(Boolean);
if (reviews.length === 0) return { error: "both reviewers failed" };
if (reviews.length === 1) return { verdict: reviews[0], note: "only one reviewer survived" };

// Agreement needs no third opinion.
if (correctness.verdict === maintainability.verdict) {
  log(`both said ${correctness.verdict}`);
  return { verdict: correctness.verdict, agreed: true, reviews };
}

phase("Reconcile");

const ruling = await agent(
  `Two reviewers disagree about ${target}.\n\n` +
    `correctness: ${JSON.stringify(correctness)}\n\n` +
    `maintainability: ${JSON.stringify(maintainability)}\n\n` +
    `Decide which is right and say why.`,
  { kind: "codex", label: "reconcile", schema: finding },
);

return { verdict: ruling, agreed: false, reviews };
