# ✨ Even Better

A Claude Code mod that asks, after Claude finishes some work: **is there a better way to do that?**

When Claude edits files or does a chunk of work, a small bar appears above your prompt:

> ✨ Even Better · Look for a better way to make a python flappy bird?  **[ Look ]**  [ Not now ]

Press **Look** and a scout agent reviews what Claude just changed, searches the web for how others solve the same problem, and comes back with a verdict. If it finds something clearly better, you get:

> ✨ Even Better · Use secrets with the EFF 7776-word list
> Swap the 32-word list for the EFF large wordlist and use `secrets`…
> [ Learn more ]  **[ Accept ]**  [ Decline ]

- **Learn more** opens a side panel with the full write-up, trade-offs and sources.
- **Accept** has Claude apply the improvement.
- **Decline** dismisses it, and the same idea won't be suggested again.

If the scout finds nothing better, it says so and gets out of the way.

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

- `/even-better`: look for a better way to do the last thing Claude did
- `/even-better level <every|work|sure|manual>`: change the level
- `/even-better status`: show the level and whether a scout is running

## Good to know

- **Nothing runs until you press Look.** The look goes into the conversation as your request, and Claude starts the scout. This also keeps it working under auto mode, which refuses agents nobody asked for.
- **The scout is read-only.** It can read files and search the web, and it never edits anything. It runs on Sonnet in its own small context, so the research costs less than asking Claude in the main conversation and doesn't fill that conversation with web pages.
- **Button hotkeys** (`e`, `l`, `a`, `d`, `n`) work once the bar has focus: click it, or press `ctrl+x` then `tab`.
- **Debug log:** turn on **Debug log** in `/config` to write each decision to `even-better.log` in your temp folder.

## License

MIT
