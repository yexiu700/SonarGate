/**
 * Compatibility re-export barrel for domestic adapters and unit tests.
 * Shared parsing and ChatCompletions helpers now live under `../shared/`.
 */
export {
  asNonEmptyString,
  asNonNegativeInt,
  asPositiveInt,
  asString,
  dedupeQueryStrings,
  deepMergeRecords,
  extractCitations as extractDomesticCitations,
  extractStringQueries,
  isPlainObject,
  isRecord,
  mergeCitations as mergeDomesticCitations,
  shallowMergeRecord,
  trimTrailingSlashes,
  type ExtractCitationOptions,
} from '../shared/parsing.js';
export {
  buildChatCompletionMeta,
  extractChatCompletionParts,
  postChatCompletion,
  type BuildChatCompletionMetaOptions,
  type ChatCompletionParts,
  type PostChatCompletionOptions,
} from '../shared/chat-completions.js';
