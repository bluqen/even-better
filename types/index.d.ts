export type Level = 'every' | 'work' | 'sure' | 'manual'

export type Confidence = 'low' | 'medium' | 'high'

export type Source = { title: string; url: string }

export type Suggestion = {
  id: string
  title: string
  summary: string
  details: string
  sources: Source[]
  instruction: string
  confidence: Confidence
}

declare module 'claude-code' {
  interface PluginState {
    'even-better': {
      suggestion: Suggestion | null
      isScouting: boolean
      isOffered: boolean
      isChecking: boolean
      isClean: boolean
    }
  }
}
