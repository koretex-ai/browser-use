# Contributing

Thanks for your interest in making Browser Use better! Contributions of every kind are welcome — bug reports, feature ideas, documentation fixes, new skills, and code.

## Ways to contribute

### 🐛 Report a bug

Open an issue and include:

- What you asked the agent to do (the task you typed)
- What happened vs. what you expected
- The relevant lines from the run trace — the trace is the debugging surface, and cost/model lines (`☁ …`) help too
- Your setup: OS, Chrome version, and whether you're running default mode, cloud-only mode, or fully local

Please **redact anything personal** from screenshots and traces before posting (the agent may have been working inside your logged-in sessions).

### 💡 Suggest an improvement

Open an issue describing the problem you're trying to solve, not just the feature you want — the design has strong opinions (judge-don't-assume, safety in code not prompts, skills as advice not macros; see [DESIGN.md](DESIGN.md)), and framing the underlying problem makes it much easier to find a solution that fits.

### 🔧 Submit a pull request

1. Fork the repo and create a branch from `main`
2. Make your change — keep PRs focused on one thing
3. For extension code, see [extension/CLAUDE.md](extension/CLAUDE.md) for build and development notes
4. Test against a real run where possible (the trace output is your proof)
5. Open the PR with a clear description of what it changes and why

Small fixes (typos, docs, obvious bugs) can go straight to a PR — no issue needed. For larger changes, opening an issue first to discuss the approach saves everyone time.

### 📘 Share a skill

Skills are plain JSON playbooks (Options → Site playbooks → Export). If you've taught the agent something useful for a popular site, consider sharing it in an issue or PR — strip anything personal first.

## Ground rules

- Be respectful and constructive
- Safety-related invariants (one-attempt side effects, honest stops, screen-wins-over-skill) are load-bearing — changes that weaken them need a very good argument
- When in doubt, ask — on GitHub or in our [Discord](https://discord.gg/4xtjpKf5p)

## Questions?

Join us on [Discord](https://discord.gg/4xtjpKf5p) — it's the fastest way to get help, discuss ideas, or just show off what the agent did for you.
