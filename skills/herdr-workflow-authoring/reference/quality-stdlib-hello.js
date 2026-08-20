// Quality-stdlib hello-world: verify() adversarially checks a claim, then
// judgePanel() scores two independent attempts and keeps the better one.
// Neither helper is special — both are plain agent()/parallel() composition
// exposed as globals so scripts don't have to hand-roll them every time.
//
//   herdr plugin action invoke herdrflow.engine.run -- "$PWD/skills/herdr-workflow-authoring/reference/quality-stdlib-hello.js" \
//     --cwd "$PWD" --fleet "$PWD/skills/herdr-workflow-authoring/reference/luna.fleet.toml"

export const meta = {
  name: "quality_stdlib_hello",
  description: "verify() checks a claim, judgePanel() picks the better of two answers",
  model: "gpt-5.6-luna",
  phases: [{ title: "Verify" }, { title: "Judge" }],
};

phase("Verify");

const claim = "TCP guarantees in-order delivery of bytes on a single connection.";

// reviewers: how many independent agents vote; threshold: fraction of
// "real=true" votes needed to accept. Each reviewer sees only the claim, not
// the other reviewers' votes — that independence is what makes it adversarial.
const checked = await verify(claim, { reviewers: 3, threshold: 0.5 });
log(`claim "${claim}" — real=${checked.real} (${checked.realCount}/${checked.total} reviewers agreed)`);

phase("Judge");

// Two different attempts at the same task, generated independently.
const [short, long] = await parallel([
  () => agent("Explain TCP retransmission in one sentence.", { label: "attempt:short" }),
  () => agent("Explain TCP retransmission thoroughly, in a short paragraph.", { label: "attempt:long" }),
]);

// A dead agent resolves to null; judgePanel only sees the survivors.
const attempts = [short, long].filter(Boolean);
const winner = await judgePanel(attempts, {
  judges: 3,
  rubric: "clarity and correctness for a junior engineer",
});

log(`judgePanel picked attempt #${winner.index} with mean score ${winner.score.toFixed(2)}`);

return { claim: checked, winner };
