# Harness engineering, in practice

*What it's buying you, what to invest in, and what to skip.*

**In one sentence:** harness engineering is about building compounding feedback loops so confidence stops costing human attention. This guide assumes you're working on code that will be maintained, reviewed, and deployed by a team; if you're prototyping a throwaway script, most of this doesn't apply.

> The vocabulary here (harness, guides, sensors, computational, inferential, regulation categories) borrows from Birgitta Böckeler's [Harness engineering for coding agent users](https://martinfowler.com/articles/harness-engineering.html), which frames the harness as a cybernetic governor: a feedback-control loop that keeps an agent's output close to a desired state. She acknowledges that "harness" has a wider industry meaning (everything in an agent except the model: orchestration, sandboxing, memory, tool connectivity, as in Amazon Bedrock AgentCore Harness or OpenAI's Codex harness) and bounds her use of the term to a specific context: the controls a coding agent's *user* engineers around the agent. This guide stays in that bounded context.

---

## What confidence buys you

When you ask a coding agent to make a change, the question that matters is not "did it produce code?" but "how much can I trust it without reading every line?" That question is about **confidence**, and confidence is what authorises three concrete decisions:

- **Go / no-go to production.** Different changes sit at different risk tiers, and each tier expects a different set of checks to have passed. The bar is "did the checks that matter for this tier all agree."
- **How much human review is needed.** High confidence shifts review from "eyeball every line" to "sanity-check the design and trust the harness for the rest."
- **How much autonomy the agent gets.** Agents need supervision today not because they can't write code, but because the surrounding checks aren't strong enough to let humans step back.

The rest of this guide is about how to raise confidence efficiently, and where to *not* spend effort.

---

## The framework, in one page

Three categories you can regulate, two halves of every harness, two flavours of each. That's the whole vocabulary.

**Three regulation categories**, in roughly increasing difficulty:

- **Maintainability.** Internal code quality: duplication, complexity, naming, style. Easiest to harness because tooling is mature (linters, type checkers, complexity analysers).
- **Architecture fitness.** Non-functional requirements: performance, observability, security posture, deployment correctness. Tooling exists (load tests, SLO monitors, infrastructure-as-code validators) but feedback is slower and noisier. The useful frame is *fitness functions*: write down what good looks like, then build a check that measures it.
- **Behaviour.** Whether the system does what was asked. The hardest one. Specs are incomplete, AI-generated tests verify what the agent thought it should do, and human review covers the rest.

**Two halves of every harness:**

- **Guides (feedforward)** steer the agent before it acts: system prompts, specs, steering files, AGENTS.md, conventions, skills, language servers, codemods, custom tools.
- **Sensors (feedback)** observe after the agent acts: linters, type checks, unit tests, integration tests, smoke tests, AI-judge code review, schema validators.

Some tools straddle both. A `promptSubmit` or `preToolUse` hook is a guide. A `fileEdited` or `postToolUse` hook is a sensor. What matters is *when* it fires, not the word "hook."

**Two flavours of each:**

- **Computational** controls are deterministic and fast: a linter, a type checker, a unit test. Cheap to run on every change.
- **Inferential** controls are slower and probabilistic: an AI code reviewer, a "does this match the design doc" check, a human review. More expensive. Catches semantic problems that structural tools miss.

**The mapping table.** What you might already use, in this vocabulary:

| What you already do | What it's called here |
|---|---|
| Linter, type checker, formatter | Computational sensor (maintainability) |
| Unit and integration tests | Computational sensor (behaviour, partial) |
| Pre-commit hooks running checks | Computational sensor, shifted left |
| AGENTS.md, steering files, conventions docs | Guide (feedforward) |
| Design docs, requirements docs, ADRs | Guide; behaviour-harness feedforward |
| Code review by humans | Inferential sensor (the most expensive one) |
| AI code review or "LLM as judge" | Inferential sensor, automated |
| Infrastructure-as-code validators | Computational sensor (architecture fitness) |
| SLO monitors, log alerts | Sensor running continuously, post-deploy |
| Dependabot, dead-code detectors | Continuous drift sensor |

If you're doing most of these, you have a harness. The rest of this guide is about what to do with it.

---

## Two ideas worth taking away

The vocabulary above is mostly translation. The two ideas below are what's actually worth changing in how you operate.

### 1. Investment compounds unevenly

A prompt is paid once. A steering file is paid every time the agent works in that area. A sensor is paid every time the code is changed by anyone, agent or human, forever.

If you have an hour to spend on improving how an agent works in your codebase, the marginal return looks like this:

| Where you spend it | Pays off | Compounds? |
|---|---|---|
| Tweaking the prompt for one task | Once | No |
| Adding a steering file for that area | Every task in that area | Partially |
| Adding a sensor that runs on every commit | Every change to the codebase, forever | Yes |

The mistake most teams make is pouring effort into rewriting prompts. Prompt work is necessary but it doesn't compound. **Sensor work compounds.** When you have a choice, choose the sensor.

### 2. Steering file → Power → harness template

There's a progression in how you can package expertise into the harness. Each step is more complete than the last.

- **A steering file** is a single guide. It tells the agent about naming conventions, file locations, or contract expectations for one module type. Improves the first attempt but doesn't verify anything.
- **A packaged checklist (a "Power")** operates primarily as a rich guide loaded during generation, so the agent produces well-architected code from the start. It also provides an on-demand review skill that acts as an inferential sensor when explicitly invoked. The guide half is always-on; the sensor half depends on someone remembering to ask.
- **A full harness template** closes that gap with automation. Imagine an "AWS event-processing service" template that ships with a Well-Architected Power (rich guide + on-demand review) + checkov rules that run on every commit (computational sensor) + integration tests + a post-deploy latency monitor. You instantiate it for a new service and get a working harness on day one.

The gap between a Power and a harness template is **automation**. A Power makes expert knowledge available; a harness template makes it unavoidable.

The takeaway: every time you find yourself copying the same set of guides and sensors from one service to another, you're discovering what your harness template should contain. Name it. Version it. Maintain it.

---

## A real example: the same PR, reviewed twice

Computational sensors (linters, type checkers, structural tests) catch reliable, structural failures cheaply. Inferential sensors (AI reviewers, semantic checklists) catch meaning-level failures that structural tools miss entirely. Neither replaces the other; a balanced harness uses both. The following case study shows this concretely.

In [*My AI-Assisted Code Review Missed a Security Gap. Then I Gave It a Checklist.*](https://builder.aws.com/content/3Aaa9CYr87ZWk3UdBww172wdTUf/my-ai-assisted-code-review-missed-a-security-gap-then-i-gave-it-a-checklist), the author runs the same 19-file infrastructure PR through an AI code review twice: once with no domain framework, once with a structured Well-Architected checklist loaded as a guide. The first review gave security a clean pass. The second flagged a missing HTTPS-only policy on an SNS topic, with file references, exact fix code, and compliance impact (SOC 2, PCI-DSS).

What this concretely shows about the framework:

- **The existing harness wasn't enough.** The team had checkov in CI, a computational sensor for infrastructure misconfigurations. It didn't catch the HTTPS gap because it has no rule for `aws:SecureTransport` on SNS topics. Adding a richer inferential sensor (the Well-Architected checklist) found what the computational one missed.
- **The categories show up clearly.** The HTTPS gap is architecture fitness. The Python serialisation bug the first review caught is behaviour. Both reviews are useful. Neither replaces the other.
- **The fix was primarily a guide.** The author shipped a packaged checklist (a "Power") that loads expert knowledge as feedforward context. In this case, it was invoked as a reviewer (sensor mode). Loaded during generation, the gap might not have existed at all (guide mode). Either way, encoding what experts check stops it depending on whether they're in the room.

The honest summary in the article: *"Powers aren't magic. They're packaged expertise."* That's the practical answer to "how do you raise confidence." Package what experts check, make it run on every change, and treat the checklist itself as something the team maintains.

---

## A self-audit

Five questions. Each "no" comes with a suggested first move.

**1. Do different changes go through different sensors?** If every change goes through the same gauntlet, you're over-testing the safe stuff and under-testing the risky stuff. **First move:** write down two or three risk tiers and what's required at each.

**2. For each class of failure, can you name the sensor that would catch it?** "Compile error → type checker; contract break → integration test; semantic bug → review or AI judge; perf regression → load test." If you can't articulate this, there's a class of failure you're trusting nothing in particular to catch. **First move:** list the last five production incidents. For each, ask "what kind of sensor would have caught this." The gaps in the list are where to invest.

**3. When something breaks twice, do you add a sensor or just fix?** If recurring bugs only produce fixes, the learning lives in someone's head. **First move:** the next time something breaks, before declaring the fix done, ask "what sensor would have caught this." If it's cheap, add it.

**4. Do you know roughly how often the harness misses something?** Of the last hundred changes that passed all gates, how many caused incidents? **First move:** start tracking incidents that passed all gates. Even an informal tally is enough to spot whether the rate is trending down.

**5. Is sensor maintenance ever on a roadmap?** If sensors decay, "all green" stops meaning much. **First move:** every quarter, audit one part of the harness. Pick a noisy test, a flaky check, an unused linter rule. Fix or remove it.

If you answered "no" to two or more, those are your highest-leverage moves.

---

## Why it never reaches 100%, and how to measure it

Three structural reasons confidence has a ceiling below 100%, none of which go away with a better model:

- **Specifications are incomplete.** You can never write down everything you mean. The harness can only catch what it knows to look for.
- **Sensors are partial.** Each one catches a specific class of bug. None catch "the design is correct but addresses the wrong problem." Misdiagnosis, overengineering, and misunderstood requirements survive every harness ever built.
- **Models are non-deterministic.** Even with perfect context, the same prompt can produce slightly different work on different runs. You can compress that variance with redundant sensors but not eliminate it.

Accepting a ceiling below 100% is not lowering the bar. It's redirecting human attention from line-by-line vigilance to design judgment and to the harness itself. **The harness doesn't maintain itself.**

Three signals tell you whether the harness is actually working:

1. **Green-rate after human review.** When a human reviews an agent-produced change that passed all gates, how often do they find something material? If almost never, the harness covers its categories. If regularly, you have blind spots.
2. **Incident-escape rate.** Of the last N changes that passed all gates and shipped, how many caused production incidents? Tracking this number, even informally, is the only way to know whether the harness is getting stronger or just getting bigger.
3. **Sensor false-positive rate.** When a sensor fires, how often does the team override it because it's wrong? High false-positive rates train people to ignore signals. A sensor that's ignored is worse than no sensor: it creates a false floor.

### Harnessability

Not every codebase is equally easy to harness. A strongly typed language gives you a type checker as a free sensor. Clear module boundaries let you write architectural constraint tests. A well-factored service is easier to wrap with integration tests than a monolith with shared mutable state.

When harnessability is low, start with the cheapest computational sensors your stack allows (a linter and a type checker in strict mode at minimum) and invest incrementally. Don't wait for the codebase to be "clean enough" to harness; the harness is one of the things that makes it cleaner over time.

---

## Closing thought

When tests pass but production fails, the pattern is the same: the test verified the agent's model of the system, not the system itself. Naming that gap, and treating "did I run the available external sensor" as a real question rather than just "did my tests pass," is the change in practice this vocabulary is asking for.

It won't make confidence 100%. It will move it from "the work I did locally looks clean" to "the available sensors agree it's clean." That's a smaller gap than it sounds, and a much better place to stop.
