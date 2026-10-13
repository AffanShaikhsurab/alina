# Alina: mission

This file explains what Alina is for, the ideas it is built on, and where it is going. It is written for contributors and for AI agents working in this repository, so they can make changes that point in the same direction. For setup and features, see [README.md](./README.md).

## The problem

Most "AI assistants" are chat windows. You ask, they answer, and then they forget. Using them for real work turns you into their manager:
- you re-explain context every time
- you check whether they actually did what they said
- you chase them for status
- you clean up when they guess

The work moves, but the mental load stays with you.

A good human chief of staff works the other way. You say a thing once. They own it until it is done, tell you before you have to ask, show their work, check with you only when the decision is yours, and keep a team behind them that is held to a standard. **Alina is an attempt to build that, in software you own and run yourself.**

## What Alina is

One assistant you talk to, mostly by voice, from your phone. Behind her are three kinds of help:

1. **Alina herself** for anything that can be answered or done in the moment, with sources.
2. **Personal bots** for small recurring jobs: a morning mail summary, a reading pick, reminders. They work in the background and report to Alina, never to you.
3. **AI departments** for real work that must be right, such as research, marketing, sales and engineering. Each department has a head that reviews its workers. Work passes a deterministic check (no AI) before review, and anything irreversible waits for your one tap.

You hear from one voice. Everything else is visible if you want to look: on a board, in a ticket, in a transcript.

## Principles

These decide trade-offs. If a change works against one of them, it needs a strong reason.

1. **One door.** Only Alina talks to the user. Bots and departments report to her, and she batches what matters. More bots must never mean more notifications.
2. **Say it once.** A request becomes a tracked commitment with an owner, a definition of done and a promised time for the next update. A user asking "is it done?" counts as a bug in the system.
3. **Silence is trustworthy.** If nothing is said, everything is on track. Missed promises are caught by monitors that use no AI, not by the user.
4. **Proof, not claims.** Every result carries receipts: sources with times, what ran, what it cost, and what was checked. "Done" means the real-world state changed and can be shown.
5. **Checked before it reaches you.** Workers don't grade their own work. A script checks the contract, then a reviewer on a different model family checks the substance.
6. **Autonomy is earned.** New kinds of action start as drafts. The right to act alone is granted per action type, from measured approval rates, and is lost on the first incident. Sending, posting, paying and deleting always start behind a human tap.
7. **Broken tools say so.** Every capability is tested daily. A red tool is named as red; nothing pretends a broken integration works.
8. **Your data, your server, your models.** Self-hosted, private by default, with bring-your-own model and voice providers and a hard monthly spend cap. Nothing is sent anywhere the owner didn't choose.
9. **Memory lives in plain files, not in the harness.** Agent definitions, rules, lessons and transcripts live in git, and harness configs are generated from them. Switching runtime must not lose anything.
10. **Small, testable, reversible.** Prefer a hundred-line script with tests over a new service. Every change is opt-in, every deploy step can be undone, and upstream merges stay clean.

## How it is built today

- **Front door:** this repository, a fork of [Rakazo](https://github.com/elie222/rakazo).
  - The web, desktop and mobile apps.
  - Persistent bots with routines and memory.
  - Sandboxed computers.
  - MCP tools.
  - Voice through Deepgram and Sarvam, with listening and speaking set separately.
  - Silent background runs, so bots don't ping the user.
- **Workforce:** a separate task control plane (currently [Paperclip](https://github.com/paperclipai/paperclip)).
  - Departments, tickets, review stages, budgets and a board to watch.
  - Agents running on an agent runtime (currently Hermes Agent).
  - Alina files work there over MCP, and completions come back to her through a webhook.
- **Operations:** small scripts with no AI that watch the system: a host sentinel, a promise watchdog, a daily capability canary, transcript export, and email alerts that work even when Alina is down.
- **Models:** any provider supported by Rakazo's Pi integration; Amazon Bedrock works keylessly through an instance role.

## Where it is heading

**Near term**
- Our own mobile builds, so call audio always uses the server's speech recognition.
- Alina can comment on and update workforce tickets directly, not only create them.
- Hardened single-server deploy kit: one command to deploy, verify and roll back.
- Offer the general voice changes upstream to Rakazo.

**Next**
- **Department hiring by test:** a department head is only "hired" after catching planted defects in an evaluation set. Workers are hired the same way.
- **Shared knowledge:** skills and playbooks loaded per role from a git knowledge base, with "never load" boundaries.
- **A weekly one-page report** from Alina: goals, numbers, decisions needed, nothing else.
- **More personal bots** defined in git: reading maps, writing prompts, life-admin sweeps.

**Later**
- The trust ladder in practice: per-action autonomy driven by measured approval rates.
- Multi-user and team setups, where several people share departments but each has their own Alina.
- A plug-in model for departments, so a new team (sales, support, finance) is a package rather than a project.
- Deeper owner-defined rules: a written working agreement (hours, quiet time, what counts as urgent, spending limits) that Alina enforces.

## Non-goals

- **Not a life coach.** Alina runs the work; deciding what your life should be about is yours.
- **Not a chat product for the public.** It is a single-owner system you host.
- **Not a replacement for your judgement** on money, public posts, relationships or anything irreversible.
- **No dark patterns:** no fake urgency, no invented numbers or testimonials, no engagement tricks.

## Guidance for contributors and agents

- Keep Alina changes **small and opt-in** (behind settings) and **mark them** with a short `LifeOS:` comment, so upstream merges stay easy.
- Merge upstream Rakazo on a test branch, then run type check, lint and the Alina tests before merging to the default branch.
- Every change ships with tests. No network in unit tests.
- **Never commit secrets**, real user data or personal details. This repository is public.
- When a design question comes up, check it against the principles above.
- If something general is useful to everyone (like a voice provider), shape it so it could be offered back to Rakazo.

## Glossary

| Term | Meaning |
|---|---|
| Alina | The one assistant the user talks to |
| Personal bot | A small background bot with one recurring job; reports only to Alina |
| Department | A team of AI agents (a head plus workers) for real work, run in the control plane |
| Contract check | A deterministic script that validates an output's format, receipt and evidence before review |
| Receipt | The record attached to every result: sources, run, model, cost, checks |
| `next_update_due` | The promised time of the next update on an open item |
| Trust ladder | Report → draft → act reversibly → act, granted per action type |
| `NO_RESPONSE` | What a background run returns when there is nothing worth telling the user; it stays silent |
