import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { SCOUT_MARK, parseVerdict, passesLevel, shouldCheck, taskPhrase } from './scout'
import type { Verdict } from './scout'

const verdict = (over: Partial<Verdict> = {}): Verdict => ({
  found: true,
  confidence: 'high',
  title: 'Use the built-in',
  summary: 'There is a standard library helper for this.',
  details: 'Details.',
  sources: [{ title: 'Docs', url: 'https://example.com/docs' }],
  instruction: 'Replace the hand-rolled loop with the helper.',
  ...over,
})

// A scout's reply as the scout prompt asks for it.
const report = (over: Partial<Verdict> = {}) => JSON.stringify({ evenBetter: true, ...verdict(over) }, null, 2)

describe('levels', () => {
  test('shouldCheck gates by level and turn size', () => {
    const quick = { tools: 0, files: [] }
    const busy = { tools: 4, files: [] }
    const edited = { tools: 1, files: ['a.ts'] }

    expect(shouldCheck('every', quick)).toBe(true)
    expect(shouldCheck('work', quick)).toBe(false)
    expect(shouldCheck('work', busy)).toBe(true)
    expect(shouldCheck('sure', edited)).toBe(true)
    expect(shouldCheck('manual', edited)).toBe(false)
  })

  test('passesLevel filters by confidence', () => {
    expect(passesLevel('every', verdict({ confidence: 'low' }))).toBe(true)
    expect(passesLevel('work', verdict({ confidence: 'low' }))).toBe(false)
    expect(passesLevel('work', verdict({ confidence: 'medium' }))).toBe(true)
    expect(passesLevel('sure', verdict({ confidence: 'medium' }))).toBe(false)
    expect(passesLevel('sure', verdict())).toBe(true)
    expect(passesLevel('every', verdict({ found: false }))).toBe(false)
  })
})

describe('parseVerdict', () => {
  test('reads JSON inside a code fence and drops non-http sources', () => {
    const body = { ...verdict(), sources: [{ title: 'x', url: 'javascript:1' }, { url: 'https://a.dev' }] }
    const v = parseVerdict('Here:\n```json\n' + JSON.stringify(body) + '\n```')

    expect(v?.title).toBe('Use the built-in')
    expect(v?.sources).toEqual([{ title: 'https://a.dev', url: 'https://a.dev' }])
  })

  test('answers null for garbage and low for an unknown confidence', () => {
    expect(parseVerdict('no json here')).toBe(null)
    expect(parseVerdict('{ broken')).toBe(null)
    expect(parseVerdict('{"found": true, "confidence": "huge", "title": "t"}')?.confidence).toBe('low')
  })

  test('the scout mark is found however the JSON is spaced', () => {
    expect(SCOUT_MARK.test('{"evenBetter":true}')).toBe(true)
    expect(SCOUT_MARK.test(report())).toBe(true)
    expect(SCOUT_MARK.test('{"found": true}')).toBe(false)
  })

  test('taskPhrase turns the request into the end of "Look for a better way to …?"', () => {
    expect(taskPhrase('make a python flappy bird')).toBe('make a python flappy bird')
    expect(taskPhrase('Can you write a random thing in Python?')).toBe('write a random thing in Python')
    expect(taskPhrase('please Fix the login bug.')).toBe('fix the login bug')
    expect(taskPhrase('why is this slow')).toBe('do this')
    expect(taskPhrase('make ' + 'x'.repeat(80))).toBe('do this')
  })
})

const BAND = {
  plugin: 'even-better',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

type Seen = {
  prompts: { text: string; origin: string }[]
  checks: { prompt: string; model: string }[]
}

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

type Web = {
  // What the quick check and the web verdict answer.
  quick?: string
  verdict?: string
  // Whether the mod's own web search is refused (as auto mode might).
  isRefused?: boolean
}

const DOCS = 'https://docs.python.org/3/library/functions.html#sum'

// Beneath the plugin in every flow test: store, clock, an empty band, a file
// to read, and pass-through prompt, tool and turn events that record what
// they saw. Model calls answer by their system prompt (queries, quick check,
// web verdict); WebSearch finds the docs page and WebFetch reads it; an
// Agent call (Claude running the web scout) answers as a launch.
function world(on: On, web: Web = {}): Seen & { searches: string[]; fetches: string[] } {
  const seen = { prompts: [], checks: [], searches: [] as string[], fetches: [] as string[] } as Seen & {
    searches: string[]
    fetches: string[]
  }
  mock.store(on)
  mock.clock(on, { now: 1_000 })
  on('ui.render', () => ({ type: 'Box' }))
  on('fs.read', () => ({ value: 'def total(xs):\n    t = 0\n    for x in xs: t += x\n    return t\n' }))
  on('model.complete', ($, e) => {
    seen.checks.push({ prompt: String(e.prompt), model: e.model })
    const system = String(e.system)
    const text = /search queries/.test(system)
      ? '{"queries": ["python sum list builtin", "python idiomatic total"]}'
      : /research notes/.test(system)
        ? (web.verdict ?? report({ sources: [{ title: 'sum()', url: DOCS }, { title: 'made up', url: 'https://invented.example' }] }))
        : (web.quick ?? report({ sources: [] }))
    return { value: { isAnswered: true, text, usage: USAGE } }
  })
  on('prompt.submit', ($, e) => {
    seen.prompts.push({ text: e.text, origin: e.origin.kind })
    return { text: e.text }
  })
  on('tool.call', ($, e) => {
    const input = e as unknown as Record<string, unknown>
    switch (String(e.tool)) {
      case 'Agent':
        return { result: { status: 'completed', agentId: 'scout-7' } } as never
      case 'WebSearch':
        seen.searches.push(String(input.query))
        if (web.isRefused === true) return { deny: 'auto mode: no verdict' } as never
        return { result: { query: input.query, results: [{ tool_use_id: 'x', content: [{ title: 'sum()', url: DOCS }] }], durationSeconds: 1 } } as never
      case 'WebFetch':
        seen.fetches.push(String(input.url))
        return { result: { url: input.url, code: 200, codeText: 'OK', bytes: 10, durationMs: 1, result: 'Use the built-in sum().' } } as never
      default:
        return { result: {} } as never
    }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.receive', ($, e) => ({ text: e.text }))
  return seen
}

async function workTurn($: Engine, turnId = 't1') {
  await $.prompt.submit({ text: 'write a sum function', origin: { kind: 'composer' }, wait: false })
  await $.tool.call({ tool: 'Write', file_path: 'sum.py', content: 'x' } as never)
  await $.turn.complete({ answer: 'Done.', durationMs: 10, isAborted: false, turnId, reason: 'answer' })
}

async function quickTurn($: Engine) {
  await $.prompt.submit({ text: 'what is 2+2?', origin: { kind: 'composer' }, wait: false })
  await $.turn.complete({ answer: '4', durationMs: 1, isAborted: false, turnId: 'q', reason: 'answer' })
}

// Claude answering the web-research request: it runs the scout and ends its turn.
async function claudeRunsScout($: Engine, answer = report()) {
  await $.tool.call({ tool: 'Agent', subagent_type: 'even-better:scout', description: 'scout', prompt: 'brief' } as never)
  await $.turn.complete({ agentId: 'scout-7', answer, durationMs: 5, isAborted: false, turnId: 's', reason: 'answer' })
  await $.turn.complete({ answer: 'The result is in the popup.', durationMs: 5, isAborted: false, turnId: 'look', reason: 'answer' })
}

const band = ($: Engine) => $.ui.mount({ ...BAND, surface: 'terminal' })

test('a work turn only offers a look; nothing runs until the press', async ($, on) => {
  const seen = world(on)
  await workTurn($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'look' })).toBeDefined()
    expect(await ui.find({ key: 'skip' })).toBeDefined()
    await ui.unmount()
  }
  expect(seen.checks).toEqual([])
  expect(seen.prompts.length).toBe(1)
})

test('the offer names the task and says "Even Better" once', async ($, on) => {
  world(on)
  await workTurn($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: 'Look for a better way to write a sum function?' })).toBeDefined()
    expect(JSON.stringify(await ui.drawn()).match(/Even Better/g)?.length).toBe(1)
    await ui.unmount()
  }
})

test('Look runs one quick Sonnet check over the changed files, with no turn of Claude', async ($, on) => {
  const seen = world(on)
  await workTurn($)
  const ui = await band($)
  await ui.press({ key: 'look' })

  expect(seen.checks.length).toBe(1)
  expect(seen.checks[0]?.model).toBe('sonnet')
  expect(seen.checks[0]?.prompt).toMatch(/--- sum\.py\ndef total/)
  expect(seen.prompts.length).toBe(1)

  expect(await ui.find({ text: /Use the built-in/ })).toBeDefined()
  for (const key of ['learn', 'accept', 'decline', 'web']) expect(await ui.find({ key })).toBeDefined()
})

test('nothing better found: the band says so and offers the web', async ($, on) => {
  world(on, { quick: report({ found: false }) })
  await workTurn($)
  const ui = await band($)
  await ui.press({ key: 'look' })

  expect(await ui.find({ text: /No clearly better way found/ })).toBeDefined()
  expect(await ui.find({ key: 'web' })).toBeDefined()
  await ui.press({ key: 'ok' })
  expect(await ui.find({ text: /No clearly better way/ })).toBe(undefined)
})

test('Research on the web runs in the mod: search, read, judge, with no turn of Claude', async ($, on) => {
  const seen = world(on, { quick: report({ found: false }) })
  await workTurn($)
  const ui = await band($)
  await ui.press({ key: 'look' })
  await ui.press({ key: 'web' })

  expect(seen.searches).toEqual(['python sum list builtin', 'python idiomatic total'])
  expect(seen.fetches).toEqual([DOCS])
  expect(seen.prompts.length).toBe(1)
  expect(seen.checks.length).toBe(3)
  expect(seen.checks.every(c => c.model === 'sonnet')).toBe(true)
  expect(seen.checks[2]?.prompt).toMatch(/Research notes from the web:\n--- sum\(\) \(https:\/\/docs\.python\.org/)

  expect(await ui.find({ text: /Use the built-in/ })).toBeDefined()
  expect(await ui.find({ key: 'web' })).toBe(undefined)
})

test('web sources are only pages the research actually read', async ($, on) => {
  world(on, { quick: report({ found: false }) })
  await workTurn($)
  const ui = await band($)
  await ui.press({ key: 'look' })
  await ui.press({ key: 'web' })

  // The pane Learn more opens.
  const pane = await $.ui.mount({
    plugin: 'even-better',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'even-better',
    props: { title: 'Even Better', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  expect(await pane.find({ text: /docs\.python\.org/ })).toBeDefined()
  expect(await pane.find({ text: /invented\.example/ })).toBe(undefined)
})

test('when the mod may not search, Research on the web asks Claude instead', async ($, on) => {
  const seen = world(on, { quick: report({ found: false }), isRefused: true })
  await workTurn($)
  const ui = await band($)
  await ui.press({ key: 'look' })
  await ui.press({ key: 'web' })

  const asked = seen.prompts[seen.prompts.length - 1]
  expect(asked?.origin).toBe('plugin')
  expect(asked?.text).toMatch(/even-better:scout/)
  expect(await ui.find({ text: /researching on the web/ })).toBeDefined()

  await claudeRunsScout($)
  expect(await ui.find({ text: /Use the built-in/ })).toBeDefined()
  expect(await ui.find({ key: 'web' })).toBe(undefined)
  expect(await ui.find({ key: 'look' })).toBe(undefined)
})

test('if Claude never starts the scout, the band clears', async ($, on) => {
  world(on, { quick: report({ found: false }), isRefused: true })
  await workTurn($)
  const ui = await band($)
  await ui.press({ key: 'look' })
  await ui.press({ key: 'web' })
  await $.turn.complete({ answer: 'Sorry.', durationMs: 5, isAborted: false, turnId: 'look', reason: 'answer' })
  expect(await ui.find({ text: /researching/ })).toBe(undefined)
})

test('Accept sends Claude the fix, and that turn offers no new look', async ($, on) => {
  const seen = world(on)
  await workTurn($)
  const ui = await band($)
  await ui.press({ key: 'look' })
  await ui.press({ key: 'accept' })

  const sent = seen.prompts[seen.prompts.length - 1]
  expect(sent?.origin).toBe('plugin')
  expect(sent?.text).toMatch(/Replace the hand-rolled loop/)

  await $.tool.call({ tool: 'Edit', file_path: 'sum.py', old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete({ answer: 'Applied.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(await ui.find({ key: 'accept' })).toBe(undefined)
  expect(await ui.find({ key: 'look' })).toBe(undefined)
})

test('Not now and Decline clear the band', async ($, on) => {
  world(on)
  await workTurn($)
  const ui = await band($)
  await ui.press({ key: 'skip' })
  expect(await ui.find({ key: 'look' })).toBe(undefined)

  await workTurn($, 't2')
  await ui.press({ key: 'look' })
  await ui.press({ key: 'decline' })
  expect(await ui.find({ key: 'accept' })).toBe(undefined)
})

test('a low-confidence verdict stays hidden at the default level', async ($, on) => {
  world(on, { quick: report({ confidence: 'low' }) })
  await workTurn($)
  const ui = await band($)
  await ui.press({ key: 'look' })
  expect(await ui.find({ key: 'accept' })).toBe(undefined)
  expect(await ui.find({ text: /No clearly better way found/ })).toBeDefined()
})

test('a quick Q&A turn offers nothing at the default level', async ($, on) => {
  world(on)
  await quickTurn($)
  expect(await (await band($)).find({ key: 'look' })).toBe(undefined)
})

test('at level "every" a quick Q&A turn offers a look', { options: { level: 'every' } }, async ($, on) => {
  world(on)
  await quickTurn($)
  expect(await (await band($)).find({ key: 'look' })).toBeDefined()
})

test('at level "manual" a work turn offers nothing', { options: { level: 'manual' } }, async ($, on) => {
  world(on)
  await workTurn($)
  expect(await (await band($)).find({ key: 'look' })).toBe(undefined)
})

test("/even-better's replies are drawn under the name Even Better", async ($, on) => {
  world(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'even-better',
      surface,
      component: 'CommandOutput',
      props: { command: 'even-better', args: '', text: 'even-better: Nothing to check yet.', isErrored: false },
    } as never)
    expect(await ui.find({ text: /Even Better/ })).toBeDefined()
    expect(await ui.find({ text: /even-better:/ })).toBe(undefined)
    await ui.unmount()
  }
})

test("the scout's report delivery is taken quietly; other deliveries pass", async ($, on) => {
  world(on, { quick: report({ found: false }), isRefused: true })
  await workTurn($)
  const ui = await band($)
  await ui.press({ key: 'look' })
  await ui.press({ key: 'web' })
  await claudeRunsScout($)

  const scout = await $.session.receive({
    origin: { kind: 'peer-send-message' },
    text: '<agent-message from="scout-7">{"evenBetter": true}</agent-message>',
  } as never)
  expect(scout).toMatchObject({ consumed: expect.any(String) })

  const other = await $.session.receive({ origin: { kind: 'peer-send-message' }, text: 'hello from someone else' } as never)
  expect(other).toMatchObject({ text: 'hello from someone else' })
})
