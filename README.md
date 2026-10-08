# ✨ Even Better

A Claude Code mod that asks, after Claude finishes some work: **is there a better way to do that?**

When Claude edits files or does a chunk of work, a small bar appears above your prompt:

> ✨ Even Better · Look for a better way to make a python flappy bird?  **[ Look ]**  [ Not now ]

Press **Look** and a quick check (one Sonnet call, no agent) reviews your request and the files Claude just changed. If it finds something clearly better, you get:

> ✨ Even Better · Use secrets with the EFF 7776-word list
> Swap the 32-word list for the EFF large wordlist and use `secrets`…
> [ Learn more ]  **[ Accept ]**  [ Decline ]

- **Learn more** opens a side panel with the full write-up, trade-offs and sources.
- **Accept** has Claude apply the improvement.
- **Decline** dismisses it, and the same idea won't be suggested again.
- **Research on the web** has Claude send a read-only scout to search the web for how others solve the same problem; its verdict comes back with sources.

If nothing clearly better turns up, the bar says so and still offers **Research on the web**.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install even-better --marketplace OWNER/even-better
```

Answer `y` to add the marketplace, then pick a scope (user scope makes it available in every session).

## When it offers a look

Set **When to offer a look** in `/config`, or type `/even-better level <level>`:

| Level | Offers a look after | Shows suggestions that are |
|---|---|---|
| `every` | every reply | any confidence |
| `work` (default) | turns that edited files or used 3+ tools | medium or high confidence |
| `sure` | the same turns as `work` | high confidence only |
| `manual` | never on its own; type `/even-better` | any confidence |

## Commands

- `/even-better`: run the quick check on the last thing Claude did
- `/even-better web`: research it on the web instead
- `/even-better level <every|work|sure|manual>`: change the level
- `/even-better status`: show the level and whether a scout is running

## Good to know

- **Nothing runs until you press Look.**
- **The quick check is cheap.** It is one Sonnet call made by the mod itself: no agent, no turn of the main conversation, and nothing for auto mode to refuse.
- **Web research costs one turn.** Pressing **Research on the web** puts the request into the conversation, and Claude runs the scout. That keeps it working under auto mode, which refuses agents nobody asked for. The scout is read-only (it reads files and searches the web, and never edits) and runs on Sonnet in its own small context, so web pages don't fill your conversation.
- **Button hotkeys** (`e`, `l`, `a`, `d`, `n`) work once the bar has focus: click it, or press `ctrl+x` then `tab`.
- **Debug log:** turn on **Debug log** in `/config` to write each decision to `even-better.log` in your temp folder.

## License

MIT
