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
})

const BAND = {
  plugin: 'even-better',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const


type Seen = { prompts: { text: string; origin: string }[]; scoutCalls: number }

// Beneath the plugin in every flow test: store, clock, an empty band, and
// pass-through prompt, tool and turn events that record what they saw. An
// Agent call (Claude starting the scout) answers as a background launch.
function world(on: On): Seen {
  const seen: Seen = { prompts: [], scoutCalls: 0 }
  mock.store(on)
  mock.clock(on, { now: 1_000 })
  on('ui.render', () => ({ type: 'Box' }))
  on('prompt.submit', ($, e) => {
    seen.prompts.push({ text: e.text, origin: e.origin.kind })
    return { text: e.text }
  })
  on('tool.call', ($, e) => {
    if (String(e.tool) !== 'Agent') return { result: {} } as never
    seen.scoutCalls += 1
    return { result: { status: 'async_launched', agentId: 'scout-7' } } as never
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return seen
}

async function workTurn($: Engine, turnId = 't1') {
  await $.prompt.submit({ text: 'write a sum function', origin: { kind: 'composer' }, wait: false })
  await $.tool.call({ tool: 'Write', file_path: 'sum.ts', content: 'x' } as never)
  await $.turn.complete({ answer: 'Done.', durationMs: 10, isAborted: false, turnId, reason: 'answer' })
}

async function quickTurn($: Engine) {
  await $.prompt.submit({ text: 'what is 2+2?', origin: { kind: 'composer' }, wait: false })
  await $.turn.complete({ answer: '4', durationMs: 1, isAborted: false, turnId: 'q', reason: 'answer' })
}

// Claude answering the look request: it starts the scout and ends its turn.
async function claudeStartsScout($: Engine) {
  await $.tool.call({ tool: 'Agent', subagent_type: 'even-better:scout', description: 'scout', prompt: 'brief', run_in_background: true } as never)
  await $.turn.complete({ answer: 'Even Better is looking.', durationMs: 5, isAborted: false, turnId: 'look', reason: 'answer' })
}

async function scoutReports($: Engine, answer = report()) {
  await $.turn.complete({ agentId: 'scout-7', answer, durationMs: 5, isAborted: false, turnId: 's', reason: 'answer' })
}

const band = ($: Engine) => $.ui.mount({ ...BAND, surface: 'terminal' })

async function lookAndReport($: Engine, answer = report()) {
  const ui = await band($)
  await ui.press({ key: 'look' })
  await claudeStartsScout($)
  await scoutReports($, answer)
  return ui
}

test('a work turn only offers a look; nothing is asked until the press', async ($, on) => {
  const seen = world(on)
  await workTurn($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'look' })).toBeDefined()
    expect(await ui.find({ key: 'skip' })).toBeDefined()
    await ui.unmount()
  }
  expect(seen.prompts.length).toBe(1)
})

test('pressing Look asks Claude, in the conversation, to start the scout', async ($, on) => {
  const seen = world(on)
  await workTurn($)
  const ui = await band($)
  await ui.press({ key: 'look' })

  const asked = seen.prompts[seen.prompts.length - 1]
  expect(asked?.origin).toBe('plugin')
  expect(asked?.text).toMatch(/even-better:scout/)
  expect(await ui.find({ text: /looking for a better way/ })).toBeDefined()
})

test("the scout's report pops up with Learn more, Accept and Decline", async ($, on) => {
  world(on)
  await workTurn($)
  const ui = await lookAndReport($)

  expect(await ui.find({ text: /Use the built-in/ })).toBeDefined()
  for (const key of ['learn', 'accept', 'decline']) expect(await ui.find({ key })).toBeDefined()
})

test('the look turn itself offers no new look', async ($, on) => {
  world(on)
  await workTurn($)
  const ui = await band($)
  await ui.press({ key: 'look' })
  await claudeStartsScout($)
  expect(await ui.find({ key: 'look' })).toBe(undefined)
  expect(await ui.find({ text: /looking for a better way/ })).toBeDefined()
})

test("if Claude never starts the scout, the band clears", async ($, on) => {
  world(on)
  await workTurn($)
  const ui = await band($)
  await ui.press({ key: 'look' })
  await $.turn.complete({ answer: 'Sorry.', durationMs: 5, isAborted: false, turnId: 'look', reason: 'answer' })
  expect(await ui.find({ text: /looking for/ })).toBe(undefined)
})

test('Accept sends Claude the fix, and that turn offers no new look', async ($, on) => {
  const seen = world(on)
  await workTurn($)
  const ui = await lookAndReport($)
  await ui.press({ key: 'accept' })

  const sent = seen.prompts[seen.prompts.length - 1]
  expect(sent?.origin).toBe('plugin')
  expect(sent?.text).toMatch(/Replace the hand-rolled loop/)

  await $.tool.call({ tool: 'Edit', file_path: 'sum.ts', old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete({ answer: 'Applied.', durationMs: 10, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(await ui.find({ key: 'accept' })).toBe(undefined)
  expect(await ui.find({ key: 'look' })).toBe(undefined)
})

test('Not now and Decline clear the band', async ($, on) => {
  world(on)
  await workTurn($)
  let ui = await band($)
  await ui.press({ key: 'skip' })
  expect(await ui.find({ key: 'look' })).toBe(undefined)

  await workTurn($, 't2')
  ui = await lookAndReport($)
  await ui.press({ key: 'decline' })
  expect(await ui.find({ key: 'accept' })).toBe(undefined)
})

test('a low-confidence report stays hidden at the default level', async ($, on) => {
  world(on)
  await workTurn($)
  const ui = await lookAndReport($, report({ confidence: 'low' }))
  expect(await ui.find({ key: 'accept' })).toBe(undefined)
  expect(await ui.find({ text: /looking for/ })).toBe(undefined)
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

test("the scout's hand-back and task notification never reach the chat; other messages do", async ($, on) => {
  const seen = world(on)
  await workTurn($)
  await lookAndReport($)
  const before = seen.prompts.length

  const handBack = await $.prompt.submit({ text: '<agent-message from="scout-7">{"evenBetter": true}</agent-message>', origin: { kind: 'peer' }, wait: false } as never)
  const notice = await $.prompt.submit({ text: '<task-notification><task-id>scout-7</task-id></task-notification>', origin: { kind: 'task-notification' }, wait: false } as never)
  expect(handBack).toMatchObject({ drop: expect.any(String) })
  expect(notice).toMatchObject({ drop: expect.any(String) })

  await $.prompt.submit({ text: '<agent-message from="someone-else">hi</agent-message>', origin: { kind: 'peer' }, wait: false } as never)
  expect(seen.prompts.length).toBe(before + 1)
})

test('taskPhrase turns the request into the end of "Look for a better way to …?"', () => {
  expect(taskPhrase('make a python flappy bird')).toBe('make a python flappy bird')
  expect(taskPhrase('Can you write a random thing in Python?')).toBe('write a random thing in Python')
  expect(taskPhrase('please Fix the login bug.')).toBe('fix the login bug')
  expect(taskPhrase('why is this slow')).toBe('do this')
  expect(taskPhrase('make ' + 'x'.repeat(80))).toBe('do this')
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
