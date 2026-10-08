import type { Confidence, Level, Source, Suggestion } from '../types'

export const LEVELS: readonly Level[] = ['every', 'work', 'sure', 'manual']

export type TurnStats = { tools: number; files: string[] }

export type Verdict = Omit<Suggestion, 'id'> & { found: boolean }

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 }

export function toLevel(value: unknown): Level {
  return LEVELS.includes(value as Level) ? (value as Level) : 'work'
}

/** Whether a finished main-loop turn earns an automatic check at this level. */
export function shouldCheck(level: Level, stats: TurnStats): boolean {
  if (level === 'manual') return false
  if (level === 'every') return true

  return stats.files.length > 0 || stats.tools >= 3
}

/** Whether a scout's verdict is worth a popup at this level. */
export function passesLevel(level: Level, verdict: Verdict): boolean {
  if (!verdict.found || verdict.title === '') return false
  if (level === 'sure') return verdict.confidence === 'high'
  if (level === 'work') return RANK[verdict.confidence] >= RANK.medium

  return true
}

/** Every scout report carries it, so a report is known even without the scout's id. */
export const SCOUT_MARK = /"evenBetter"\s*:\s*true/

export const SCOUT_PROMPT =`You are the "Even Better" scout. Claude (the main assistant) just finished a task for the person. Your job: decide whether there is a clearly better way to have done it, and if so, describe it.

How to work:
1. Read the files Claude changed (if any) to see what was actually done.
2. Search the web (WebSearch, then WebFetch on the most relevant results) for how experienced developers, official docs or well-known projects solve the same problem today. Prefer current, authoritative sources.
3. Compare. A "better way" must be concretely better: simpler, more correct, safer, faster, more idiomatic, or uses a standard/built-in instead of hand-rolled code. Style nitpicks and personal taste do not count.
4. If what Claude did is already as good as or better than what you found, say so (found: false). Being honest here matters more than finding something.

You are read-only: never edit files or run commands.

Reply with ONLY one JSON object, no prose before or after, its first key written exactly as shown:
{
  "evenBetter": true,
  "found": boolean,
  "confidence": "low" | "medium" | "high",
  "title": "short name of the better way (max ~8 words)",
  "summary": "1-2 plain sentences: what to change and why it's better",
  "details": "markdown: what Claude did, the better approach, why it's better, trade-offs, a short code sketch if useful",
  "sources": [{ "title": "page title", "url": "https://..." }],
  "instruction": "a direct instruction Claude can follow to apply the improvement to this project"
}`

/** Pulls the scout's JSON verdict out of its reply; null when there is none. */
export function parseVerdict(text: string): Verdict | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null

  const o = raw as Record<string, unknown>
  const confidence: Confidence = o.confidence === 'high' || o.confidence === 'medium' ? o.confidence : 'low'
  const sources: Source[] = Array.isArray(o.sources)
    ? o.sources
        .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
        .map(s => ({ title: str(s.title) || str(s.url), url: str(s.url) }))
        .filter(s => /^https?:\/\//.test(s.url))
        .slice(0, 8)
    : []

  return {
    found: o.found === true,
    confidence,
    title: clip(str(o.title), 120),
    summary: clip(str(o.summary), 400),
    details: str(o.details),
    sources,
    instruction: str(o.instruction),
  }
}

/** The quick check: one tool-less model call over the change itself. */
export const QUICK_PROMPT = `You are the "Even Better" quick check. Claude (the main assistant) just finished a task. You get what the person asked, Claude's reply and the files Claude changed. Decide whether there is a clearly better way to have done it.

A "better way" must be concretely better: simpler, more correct, safer, faster, more idiomatic, or a standard/built-in instead of hand-rolled code. Style nitpicks and personal taste do not count. If what Claude did is already good, say so (found: false); being honest matters more than finding something. You cannot browse, so leave "sources" empty.

Reply with ONLY one JSON object, no prose before or after:
{
  "evenBetter": true,
  "found": boolean,
  "confidence": "low" | "medium" | "high",
  "title": "short name of the better way (max ~8 words)",
  "summary": "1-2 plain sentences: what to change and why it's better",
  "details": "markdown: what Claude did, the better approach, why it's better, trade-offs, a short code sketch if useful",
  "sources": [],
  "instruction": "a direct instruction Claude can follow to apply the improvement to this project"
}`

export type ChangedFile = { path: string; text: string }

export function quickBrief(request: string, answer: string, files: readonly ChangedFile[], declined: readonly string[]): string {
  const shown = files.length > 0 ? files.map(f => `--- ${f.path}\n${f.text}`).join('\n\n') : '(no files were changed)'
  const skip = declined.length > 0 ? `\n\nThe person already declined these ideas; do not suggest them again:\n${declined.map(t => `- ${t}`).join('\n')}` : ''

  return `The person asked:\n"""\n${clip(request, 3000)}\n"""\n\nClaude's reply:\n"""\n${clip(answer, 3000)}\n"""\n\nFiles Claude changed:\n${shown}${skip}`
}

/** A changed file's text as the quick check is shown it: at most `max` characters. */
export function clipFile(text: string, max = 8000): string {
  return clip(text, max)
}

const VERBS = new Set([
  'add', 'build', 'change', 'clean', 'code', 'convert', 'create', 'debug', 'design', 'do', 'fix', 'generate',
  'implement', 'improve', 'make', 'move', 'optimize', 'refactor', 'remove', 'rename', 'rewrite', 'set', 'test',
  'update', 'write',
])

/**
 * What the person asked, as the end of "Look for a better way to …?":
 * "make a python flappy bird" from "Can you make a python flappy bird?",
 * "do this" when the request does not read as one short instruction.
 */
export function taskPhrase(request: string): string {
  let phrase = (request.split('\n')[0] ?? '').trim()
  phrase = phrase.replace(/^((please|pls|hey claude,?|can you|could you|would you)\s+)+/i, '')
  phrase = phrase.replace(/[\s.?!]+$/, '')
  const first = phrase.split(/\s+/)[0]?.toLowerCase() ?? ''
  if (phrase.length === 0 || phrase.length > 70 || !VERBS.has(first)) return 'do this'

  return first + phrase.slice(first.length)
}

/**
 * The person's request for a look, as it enters the conversation: Claude
 * briefs the scout from what it just did and waits for it in this turn, so
 * its report comes back as the Agent call's result and not as a separate
 * message that would start (or be dropped from) another turn.
 */
export function lookPrompt(task: string, declined: readonly string[]): string {
  const skip = declined.length > 0 ? ` Tell it not to suggest these ideas I already declined: ${declined.join('; ')}.` : ''

  return `Even Better: look for a better way to ${task}. Run the even-better:scout agent and wait for it (Agent tool, subagent_type "even-better:scout", run_in_background: false). Brief it with what I asked, what you did and which files you changed, and tell it to reply with its JSON verdict.${skip} When it returns, reply with one short line saying the result is in the Even Better popup; don't repeat its findings and don't do the research yourself.`
}

export function acceptPrompt(s: Suggestion): string {
  return `Even Better: apply this improvement — ${s.title}.\n\n${s.instruction || s.summary}`
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
