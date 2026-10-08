import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Level, Suggestion } from '../types'
import {
  LEVELS,
  SCOUT_MARK,
  SCOUT_PROMPT,
  QUERY_PROMPT,
  QUICK_PROMPT,
  WEB_PROMPT,
  acceptPrompt,
  clipFile,
  lookPrompt,
  parseQueries,
  quickBrief,
  webBrief,
  taskPhrase,
  parseVerdict,
  passesLevel,
  shouldCheck,
  toLevel,
} from './scout'
import type { ChangedFile, TurnStats, WebNote } from './scout'

const PANE = 'even-better'
// The theme's soft purple: light on a dark theme, deeper on a light one.
const ACCENT = 'merged'
const SCOUT = 'even-better:scout'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const suggestion = atom({ plugin: 'even-better', key: 'suggestion' } as const, null)
const isScouting = atom({ plugin: 'even-better', key: 'isScouting' } as const, false)
// "Look for a better way?" waits in the band for the person's press.
const isOffered = atom({ plugin: 'even-better', key: 'isOffered' } as const, false)
// The quick check is running; it found nothing clearly better.
const isChecking = atom({ plugin: 'even-better', key: 'isChecking' } as const, false)
const isClean = atom({ plugin: 'even-better', key: 'isClean' } as const, false)

type Turn = { request: string; answer: string; stats: TurnStats }

// Module state; a reload starts it over.
const mod = {
  // The main loop's current turn.
  request: '',
  stats: { tools: 0, files: [] } as TurnStats,
  isOwnTurn: false,
  // The last finished turn: what the scout looks at.
  last: null as Turn | null,
  // The scout running now ('' when its id is not known yet), when it started,
  // and every scout this load started.
  pendingAgentId: undefined as string | undefined,
  startedAt: 0,
  scouts: new Set<string>(),
  level: 'work' as Level,
  // The turn the person asked for a look in, and whether Claude started the scout in it.
  isLookTurn: false,
  sawScoutCall: false,
  // Write the decision log (the debugLog option).
  isTracing: false,
  // The last turn was already researched on the web: don't offer it again.
  hasSearched: false,
}

// A scout that has not reported by then is given up on.
const SCOUT_TIMEOUT_MS = 10 * 60 * 1000

export const register: Register = (on, options) => {
  const level: Level = toLevel(options.level)
  mod.level = level
  mod.isTracing = options.debugLog === true

  on('session.start', async ($, e, next) => {
    await trace($, `session.start: level=${level}`)
    try {
      const { agent } = await $.agent.register({
        name: 'scout',
        description: 'Even Better scout: reviews finished work and searches the web for a better approach.',
        prompt: SCOUT_PROMPT,
        tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
        model: 'sonnet',
        omitClaudeMd: true,
        maxTurns: 25,
      })
      await trace($, `agent registered: ${agent}`)
    } catch (err) {
      await trace($, `agent.register FAILED: ${String(err)}`)
      $.ui.toast(`Even Better · could not set up its scout (${String(err)})`)
    }
    try {
      await $.command.register({
        name: 'even-better',
        description: 'Look for a better way to do what Claude just did (web: research it on the web)',
        argumentHint: '[web | level every|work|sure|manual | status]',
      })
    } catch (err) {
      await trace($, `command.register FAILED: ${String(err)}`)
    }
    await update($, isScouting, () => false)
    await update($, isOffered, () => false)
    await update($, isChecking, () => false)
    await update($, isClean, () => false)

    return next(e)
  })

  // The model is offered the scout only in the turn the person asked for a look.
  on('agent.offer', { agent: SCOUT }, ($, e, next) => (mod.isLookTurn ? next(e) : { isOffered: false }))

  // A scout finishing sends its report to the main conversation as a message
  // (and a task notification). The report is the popup's: take the delivery
  // quietly so it never reaches the chat or starts a turn.
  on('session.receive', async ($, e, next) => {
    if (e.agentId !== undefined || ![...mod.scouts].some(id => e.text.includes(id))) return next(e)
    await trace($, `consumed the scout's ${e.origin.kind} delivery`)
    return { consumed: "Even Better: the scout's report is shown in its popup" }
  })

  on('prompt.submit', async ($, e, next) => {
    // Fallback for a scout delivery that reaches the prompt instead: drop it.
    const isDelivery = e.origin.kind === 'task-notification' || e.origin.kind === 'peer'
    if (isDelivery && [...mod.scouts].some(id => e.text.includes(id))) {
      await trace($, `dropped the scout's ${e.origin.kind} message`)
      return { drop: 'Even Better scout finished' }
    }

    mod.isOwnTurn = e.origin.kind === 'plugin' && e.origin.name === $.plugin.name
    mod.request = e.origin.kind === 'task-notification' ? '' : e.text
    mod.stats = { tools: 0, files: [] }
    // A new request makes the old offer and "nothing found" stale.
    if (!mod.isOwnTurn) {
      await update($, isOffered, () => false)
      await update($, isClean, () => false)
    }
    await trace($, `prompt.submit: origin=${e.origin.kind} chars=${e.text.length} own=${mod.isOwnTurn}`)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)

    mod.stats.tools += 1
    const input = e as unknown as Record<string, unknown>
    if (EDIT_TOOLS.has(String(e.tool))) {
      const path = input.file_path ?? input.notebook_path
      if (typeof path === 'string' && !mod.stats.files.includes(path)) mod.stats.files.push(path)
    }

    // Claude starting the scout in the turn the person asked for a look.
    if (String(e.tool) !== 'Agent' || input.subagent_type !== SCOUT) return next(e)
    mod.sawScoutCall = true
    mod.pendingAgentId = ''
    await update($, isScouting, () => true)
    const ran = await next(e)
    const record = (ran.deny === undefined ? ran.result : undefined) as Record<string, unknown> | undefined
    const agentId = typeof record?.agentId === 'string' ? record.agentId : undefined
    await trace($, `Claude started the scout: agentId=${agentId ?? '(none)'} deny=${ran.deny ?? ''}`)
    if (agentId !== undefined) mod.scouts.add(agentId)
    // Still waiting (it was not a foreground run that already reported): know it by its id.
    if (mod.pendingAgentId === '' && agentId !== undefined) mod.pendingAgentId = agentId

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    // A scout's report, when it arrives as the scout's own turn.
    if (e.agentId !== undefined) {
      const isOurs =
        mod.pendingAgentId === e.agentId || (mod.pendingAgentId === '' && SCOUT_MARK.test(e.answer))
      await trace($, `subagent turn.complete: agent=${e.agentId} ours=${isOurs} pending=${mod.pendingAgentId}`)
      if (isOurs) await handleReport($, e.answer, e.turnId)

      return result
    }

    // A main-loop turn the person asked for: offer a look, never start one unasked.
    await trace(
      $,
      `turn.complete: reason=${e.reason} request=${mod.request.length} tools=${mod.stats.tools} files=${mod.stats.files.length} own=${mod.isOwnTurn} level=${level}`,
    )
    // The look turn ended: the scout runs on, or Claude never started it.
    if (mod.isLookTurn) {
      mod.isLookTurn = false
      if (!mod.sawScoutCall) {
        mod.pendingAgentId = undefined
        await update($, isScouting, () => false)
        $.ui.status(undefined)
        $.ui.toast('Even Better · the scout did not start this time.')
      }
      return result
    }
    if (e.reason !== 'answer' || mod.request === '' || mod.isOwnTurn) return result

    mod.last = { request: mod.request, answer: e.answer, stats: { ...mod.stats, files: [...mod.stats.files] } }
    mod.hasSearched = false
    if (shouldCheck(level, mod.stats)) {
      await update($, isOffered, () => true)
      await trace($, 'offered a look')
    }

    return result
  })

  on('command.run', { command: 'even-better' }, async ($, e) => {
    const [verb, arg] = e.args.trim().split(/\s+/)

    if (verb === 'level') {
      const picked = arg ?? ''
      if (!LEVELS.includes(picked as Level)) {
        return { text: `Level is "${level}". Choose one of: ${LEVELS.join(', ')}.` }
      }
      const { deny } = await $.config.set({ key: 'even-better.level', value: picked })

      return { text: deny ?? `Even Better level set to "${picked}".` }
    }

    if (verb === 'status') {
      const running = mod.pendingAgentId !== undefined ? 'a scout is looking now' : 'idle'
      return { text: `Even Better level: "${level}" — ${running}.` }
    }

    if (mod.last === null) return { text: 'Nothing to check yet: let Claude finish something first.' }
    if (verb === 'web') return { text: await webResearch($) }

    return { text: await quickCheck($) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const s = await read($, suggestion)
    const offered = await read($, isOffered)
    const scouting = await read($, isScouting)
    const checking = await read($, isChecking)
    const clean = await read($, isClean)
    const { Box, Button, Text } = $.ui.resolve(e)
    const name = (
      <Text bold color={ACCENT}>
        ✨ Even Better ·{' '}
      </Text>
    )
    const web = mod.hasSearched ? null : (
      <Button key="web" label="Research on the web" hotkey="w" onPress={() => webResearch($)} />
    )


    if (s !== null && s !== undefined) {
      return (
        <Box flexDirection="column">
          <Text>
            {name}
            <Text bold>{s.title}</Text>
          </Text>
          <Text>{s.summary}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="learn" label="Learn more" hotkey="l" onPress={() => learnMore($)} />
            <Button key="accept" label="Accept" hotkey="a" variant="primary" onPress={() => accept($)} />
            <Button key="decline" label="Decline" hotkey="d" onPress={() => decline($)} />
            {s.sources.length === 0 && web}
          </Box>
        </Box>
      )
    }

    if (checking || scouting) {
      return (
        <Text>
          {name}
          <Text dimColor>
            {checking ? 'checking for a better way…' : 'researching on the web… (this can take a minute)'}
          </Text>
        </Text>
      )
    }

    if (clean) {
      return (
        <Box flexDirection="row" gap={1}>
          <Text>
            {name}
            <Text>No clearly better way found.</Text>
          </Text>
          {web}
          <Button key="ok" label="OK" hotkey="o" onPress={() => update($, isClean, () => false)} />
        </Box>
      )
    }

    if (offered && mod.last !== null) {
      return (
        <Box flexDirection="row" gap={1}>
          <Text>
            {name}
            <Text>Look for a better way to {taskPhrase(mod.last.request)}?</Text>
          </Text>
          <Button key="look" label="Look" hotkey="e" variant="primary" onPress={() => quickCheck($)} />
          <Button key="skip" label="Not now" hotkey="n" onPress={() => update($, isOffered, () => false)} />
        </Box>
      )
    }

    return next(e)
  })

  // /even-better's replies, under the mod's own name.
  on('ui.render', { component: 'CommandOutput', props: { command: 'even-better' } }, async ($, e) => {
    const { Text } = $.ui.resolve(e)

    return (
      <Text>
        <Text color={ACCENT}>✨ Even Better · </Text>
        <Text color={e.props.isErrored ? 'error' : undefined}>{e.props.text.replace(/^even-better:\s*/, '')}</Text>
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const s = await read($, suggestion)

    if (s === null || s === undefined) {
      return <Text dimColor>No suggestion right now.</Text>
    }

    const sources =
      s.sources.length > 0 ? `\n\n### Sources\n${s.sources.map(x => `- [${x.title}](${x.url})`).join('\n')}` : ''
    const text = `## ${s.title}\n\n_Confidence: ${s.confidence}_\n\n${s.summary}\n\n${s.details}${sources}`

    return (
      <Box flexDirection="column" gap={1}>
        <Markdown key="details" text={text} />
        <Box flexDirection="row" gap={1}>
          <Button key="pane-accept" label="Accept" hotkey="a" variant="primary" onPress={() => accept($)} />
          <Button key="pane-decline" label="Decline" hotkey="d" onPress={() => decline($)} />
        </Box>
      </Box>
    )
  })
}

/**
 * The quick check of the last finished turn: one tool-less Sonnet call over
 * the request, Claude's reply and the changed files. No agent and no turn of
 * Claude's, so it costs little and auto mode has nothing to refuse.
 */
async function quickCheck($: EngineInterface): Promise<string> {
  const turn = mod.last
  if (turn === null) return 'Nothing to check yet.'
  if ((await read($, isChecking)) || mod.pendingAgentId !== undefined) return 'Already looking.'

  await update($, isOffered, () => false)
  await update($, isClean, () => false)
  await update($, isChecking, () => true)
  try {
    const brief = quickBrief(turn.request, turn.answer, await readChanged($, turn), await declinedTitles($))
    const done = await sonnet($, QUICK_PROMPT, brief)
    if (done === null) return 'The check could not finish.'

    return await showVerdict($, done, [])
  } finally {
    await update($, isChecking, () => false)
  }
}

/**
 * Web research on the last finished turn, run by the mod itself: Sonnet
 * writes two queries, the mod searches and reads the top pages, and Sonnet
 * judges against those notes. No agent and no turn of Claude's. Where the
 * web tools are refused, it falls back to asking Claude to run the scout.
 */
async function webResearch($: EngineInterface): Promise<string> {
  const turn = mod.last
  if (turn === null) return 'Nothing to check yet.'
  if ((await read($, isScouting)) || mod.pendingAgentId !== undefined) return 'Already researching.'

  await update($, isOffered, () => false)
  await update($, isClean, () => false)
  await update($, suggestion, () => null)
  mod.hasSearched = true
  await update($, isScouting, () => true)
  let done = false
  try {
    const brief = quickBrief(turn.request, turn.answer, await readChanged($, turn), await declinedTitles($))
    const planned = await sonnet($, QUERY_PROMPT, brief)
    const queries = planned === null ? [] : parseQueries(planned)
    if (queries.length === 0) return 'The research could not start.'

    // The pages to read: the top hit of each query, then the next ones.
    const hits: { title: string; url: string }[] = []
    for (const query of queries) {
      const ran = await $.tool.call({ tool: 'WebSearch', query, mode: 'standard' })
      if (ran.deny !== undefined || ran.isError === true) {
        await trace($, `web search refused (${ran.deny ?? ran.text ?? 'error'}): falling back to Claude's scout`)
        done = true
        await update($, isScouting, () => false)
        return startScout($, 'The user asked Even Better to research on the web')
      }
      const found = ((ran.result as { results?: unknown[] } | undefined)?.results ?? []).flatMap(r =>
        typeof r === 'object' && r !== null && Array.isArray((r as { content?: unknown }).content)
          ? ((r as { content: { title?: unknown; url?: unknown }[] }).content)
          : [],
      )
      for (const hit of found) {
        if (typeof hit.url === 'string' && /^https?:\/\//.test(hit.url) && !hits.some(h => h.url === hit.url)) {
          hits.push({ title: typeof hit.title === 'string' ? hit.title : hit.url, url: hit.url })
        }
      }
    }
    await trace($, `web search: ${queries.length} queries, ${hits.length} hits`)

    const notes: WebNote[] = []
    for (const hit of hits.slice(0, 2)) {
      const read = await $.tool.call({
        tool: 'WebFetch',
        url: hit.url,
        prompt: `What does this page recommend for this task: ${taskPhrase(turn.request)}? Summarize the relevant advice, with any key code, in under 200 words.`,
      })
      const page = read.deny === undefined && read.isError !== true ? (read.result as { result?: unknown } | undefined) : undefined
      if (typeof page?.result === 'string') notes.push({ ...hit, notes: page.result })
    }
    await trace($, `web fetch: read ${notes.length} pages`)

    const judged = await sonnet($, WEB_PROMPT, webBrief(brief, notes))
    if (judged === null) return 'The research could not finish.'
    // Only pages it actually read may stand as sources.
    return await showVerdict($, judged, notes.map(n => n.url))
  } catch (err) {
    await trace($, `web research failed: ${String(err)}`)
    $.ui.toast(`Even Better · the research could not finish (${String(err).slice(0, 150)})`)
    return 'The research could not finish.'
  } finally {
    if (!done) await update($, isScouting, () => false)
  }
}

/** One Sonnet call; null, with a notice, when it does not answer. */
async function sonnet($: EngineInterface, system: string, prompt: string): Promise<string | null> {
  const done = await $.model.complete({ model: 'sonnet', system, prompt, maxTokens: 2500, timeoutMs: 90_000 })
  if (done.isAnswered) return done.text

  await trace($, `model call failed: ${done.reason}`)
  $.ui.toast(`Even Better · the check could not finish (${done.reason})`)
  return null
}

/** Puts a verdict up as the popup, or "nothing better found"; `sourceUrls` are the pages it may cite. */
async function showVerdict($: EngineInterface, text: string, sourceUrls: readonly string[]): Promise<string> {
  const verdict = parseVerdict(text)
  const kept: Suggestion | null =
    verdict !== null && passesLevel(mod.level, verdict)
      ? { ...verdict, sources: verdict.sources.filter(s => sourceUrls.includes(s.url)), id: `check-${Date.now()}` }
      : null
  await trace($, `verdict: found=${verdict?.found} confidence=${verdict?.confidence} shown=${kept !== null}`)
  if (kept !== null) {
    await update($, suggestion, () => kept)
    return `Found one: ${kept.title}`
  }
  await update($, isClean, () => true)
  return 'No clearly better way found.'
}

/** The files the turn changed (at most four), each clipped; a gone or unreadable one is left out. */
async function readChanged($: EngineInterface, turn: Turn): Promise<ChangedFile[]> {
  const files: ChangedFile[] = []
  for (const path of turn.stats.files.slice(0, 4)) {
    try {
      const text = await $.fs.read(path)
      if (typeof text === 'string') files.push({ path, text: clipFile(text) })
    } catch {
      // Gone or unreadable: the check goes on without it.
    }
  }
  return files
}

/**
 * Asks for web research on the last finished turn. Only ever called from
 * something the person did (a press, a command). Auto mode refuses an agent a
 * plugin starts unasked, so the ask goes into the conversation as the
 * person's request and Claude starts the scout; `why` says what they did.
 */
async function startScout($: EngineInterface, why: string): Promise<string> {
  if (mod.last === null) return 'Nothing to check yet.'
  const now = await $.clock.now()
  if (mod.pendingAgentId !== undefined && now - mod.startedAt < SCOUT_TIMEOUT_MS) return 'A scout is already looking.'

  await update($, isOffered, () => false)
  await update($, isClean, () => false)
  await update($, suggestion, () => null)
  const declined = await declinedTitles($)
  // Known by the mark its report carries until Claude's Agent call names it.
  mod.pendingAgentId = ''
  mod.startedAt = now
  mod.isOwnTurn = true
  mod.isLookTurn = true
  mod.sawScoutCall = false
  mod.request = lookPrompt(taskPhrase(mod.last.request), declined)
  mod.stats = { tools: 0, files: [] }
  await update($, isScouting, () => true)
  $.ui.status('✨ Even Better · looking for a better way…')
  try {
    await $.prompt.submit({ text: mod.request, asUser: true })
  } catch (err) {
    mod.isLookTurn = false
    mod.pendingAgentId = undefined
    await update($, isScouting, () => false)
    $.ui.status(undefined)
    return scoutFailed($, why, String(err))
  }
  await trace($, `asked Claude for a look (${why})`)

  return 'Asked Claude to start the scout…'
}

async function handleReport($: EngineInterface, answer: string, id: string) {
  if (mod.pendingAgentId === undefined) return // already handled

  const verdict = parseVerdict(answer)
  const kept: Suggestion | null =
    verdict !== null && passesLevel(mod.level, verdict) ? { ...verdict, id } : null
  await trace(
    $,
    verdict === null
      ? `scout report unreadable: ${answer.slice(0, 300)}`
      : `scout verdict: found=${verdict.found} confidence=${verdict.confidence} title="${verdict.title}" shown=${kept !== null}`,
  )

  mod.pendingAgentId = undefined
  await update($, isScouting, () => false)
  $.ui.status(undefined)
  if (kept !== null) {
    await update($, suggestion, () => kept)
  } else {
    $.ui.toast('Even Better · no clearly better way found. Nice work.')
  }
}

async function scoutFailed($: EngineInterface, why: string, reason: string): Promise<string> {
  await trace($, `scout could not start (${why}): ${reason}`)
  $.ui.toast(`Even Better · the scout could not start (${reason.slice(0, 200)})`)
  return `Could not start the scout: ${reason}`
}

async function accept($: EngineInterface) {
  const s = await read($, suggestion)
  if (s === null || s === undefined) return

  await update($, suggestion, () => null)
  await closePane($)
  // A plugin's own prompt may skip its own prompt.submit hook: mark the turn here.
  mod.isOwnTurn = true
  mod.request = acceptPrompt(s)
  mod.stats = { tools: 0, files: [] }
  await $.prompt.submit({ text: mod.request, asUser: true })
}

async function decline($: EngineInterface) {
  const s = await read($, suggestion)
  await update($, suggestion, () => null)
  await closePane($)
  if (s !== null && s !== undefined) {
    const titles = await declinedTitles($)
    await $.store.set('declined', [...titles, s.title].slice(-50))
  }
}

async function learnMore($: EngineInterface) {
  await $.ui.open({ id: PANE, title: 'Even Better' })
}

// With the debugLog option on, the last decisions are written to
// even-better.log in the temp folder (never the mod's own folder: a write
// there would reload the mod).
const traceLines: string[] = []

async function trace($: EngineInterface, line: string) {
  if (!mod.isTracing) return
  try {
    const at = new Date(await $.clock.now()).toISOString().slice(11, 19)
    traceLines.push(`${at} ${line}`)
    if (traceLines.length > 200) traceLines.shift()
    const dir = (await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'
    await $.fs.write(`${dir}/even-better.log`, traceLines.join('\n') + '\n')
  } catch {
    // Tracing never gets in the way.
  }
}

async function declinedTitles($: EngineInterface): Promise<string[]> {
  const stored = await $.store.get('declined')
  return Array.isArray(stored) ? stored.filter((t): t is string => typeof t === 'string') : []
}

async function closePane($: EngineInterface) {
  try {
    await $.ui.close({ id: PANE })
  } catch {
    // Not open.
  }
}
