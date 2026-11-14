// Type surface for the .mjs generator shared by the stand and the tests.
// Types only: the implementation stays a plain ES module so tools/*.mjs can
// import it without a build step.
import type { ChatExport } from '../../src/core/types'

export type MegaHubOpts = {
  messages?: number
  vocab?: number
  topics?: number
  hubShare?: number
  semiHubShare?: number
  backgroundShare?: number
  zipf?: number
  seed?: number
}

export declare const MEGA_DEFAULTS: Required<MegaHubOpts>
export declare const HUB_WORDS: [string, string, string]
export declare function buildMegaHubChat(opts?: MegaHubOpts): ChatExport
