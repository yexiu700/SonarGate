import type { RawCitation } from '../../core/types.js';

const FORBIDDEN_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface ExtractCitationOptions {
  /** When true (Tongyi), falls back to `site_name` if snippet/content/summary/desc are absent. */
  fallbackSnippetToSiteName?: boolean | undefined;
}

/** Narrow unknown to non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow unknown to plain object (Object.prototype or null prototype) for safe deep merging. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Return string as-is if typeof === 'string', else undefined (preserves formatting for answerText). */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Return trimmed string if typeof === 'string' and trimmed.length > 0, else undefined. */
export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Return integer >= 0 if finite integer, else undefined (matches collectResponseSchema tokensIn/Out). */
export function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return undefined;
}

/** Return integer > 0 if finite positive integer, else undefined (for optional citation position). */
export function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  return undefined;
}

/** Strip trailing slashes from a base URL. */
export function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Deduplicate trimmed non-empty strings preserving first occurrence (case-insensitive key). */
export function dedupeQueryStrings(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of items) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

/** Extract trimmed non-empty strings from an unknown array (or single string), deduplicated preserving order. */
export function extractStringQueries(value: unknown): string[] {
  if (typeof value === 'string') {
    return dedupeQueryStrings([value]);
  }
  if (!Array.isArray(value)) {
    return [];
  }

  const collected: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      collected.push(item);
    }
  }
  return dedupeQueryStrings(collected);
}

/**
 * Defensive citation extractor:
 * - URL:     url ?? link ?? href ?? source_url
 * - Title:   title ?? name ?? site_name
 * - Snippet: snippet ?? content ?? summary ?? desc (plus site_name if options.fallbackSnippetToSiteName)
 * - Position (optional): positive int from position ?? index
 * Also accepts bare string URL elements (e.g. DeepSeek/Perplexity `data.citations: ["https://..."]`).
 * Deduplicates by trimmed URL preserving first occurrence.
 */
export function extractCitations(
  rawList: unknown,
  options?: ExtractCitationOptions,
): RawCitation[] {
  if (!Array.isArray(rawList)) {
    return [];
  }

  const seenUrls = new Set<string>();
  const citations: RawCitation[] = [];

  for (const entry of rawList) {
    if (typeof entry === 'string') {
      const url = asNonEmptyString(entry);
      if (url === undefined || seenUrls.has(url)) {
        continue;
      }
      seenUrls.add(url);
      citations.push({ url });
      continue;
    }

    if (!isRecord(entry)) {
      continue;
    }

    const url =
      asNonEmptyString(entry['url']) ??
      asNonEmptyString(entry['link']) ??
      asNonEmptyString(entry['href']) ??
      asNonEmptyString(entry['source_url']);

    if (url === undefined || seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);

    const title =
      asNonEmptyString(entry['title']) ??
      asNonEmptyString(entry['name']) ??
      asNonEmptyString(entry['site_name']);

    const snippet =
      asNonEmptyString(entry['snippet']) ??
      asNonEmptyString(entry['content']) ??
      asNonEmptyString(entry['summary']) ??
      asNonEmptyString(entry['desc']) ??
      (options?.fallbackSnippetToSiteName === true
        ? asNonEmptyString(entry['site_name'])
        : undefined);

    const position = asPositiveInt(entry['position']) ?? asPositiveInt(entry['index']);

    const citation: RawCitation = {
      url,
      ...(title !== undefined ? { title } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
      ...(position !== undefined ? { position } : {}),
    };

    citations.push(citation);
  }

  return citations;
}

/**
 * Merge multiple raw citation sources in priority order and deduplicate by trimmed URL
 * preserving first occurrence.
 */
export function mergeCitations(
  sources: readonly unknown[],
  options?: ExtractCitationOptions,
): RawCitation[] {
  const seenUrls = new Set<string>();
  const merged: RawCitation[] = [];

  for (const source of sources) {
    const extracted = extractCitations(source, options);
    for (const citation of extracted) {
      if (seenUrls.has(citation.url)) {
        continue;
      }
      seenUrls.add(citation.url);
      merged.push(citation);
    }
  }

  return merged;
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item));
  }
  if (isPlainObject(value)) {
    const cloned: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_MERGE_KEYS.has(key)) {
        continue;
      }
      const val = value[key];
      if (val !== undefined) {
        cloned[key] = cloneValue(val);
      }
    }
    return cloned;
  }
  return value;
}

/**
 * Prototype-pollution-safe shallow merge.
 * Skips __proto__, constructor, prototype and undefined values. Does not mutate inputs.
 */
export function shallowMergeRecord(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(base)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    const val = base[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }

  for (const key of Object.keys(override)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    const val = override[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }

  return result;
}

/**
 * Prototype-pollution-safe deep merge.
 * - Skips __proto__, constructor, prototype and undefined values.
 * - Recursively merges when both base[k] and override[k] are plain objects.
 * - Replaces arrays (cloned) and primitives.
 * - Does not mutate base or override.
 */
export function deepMergeRecords(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(base)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    const val = base[key];
    if (val !== undefined) {
      result[key] = cloneValue(val);
    }
  }

  for (const key of Object.keys(override)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    const overrideVal = override[key];
    if (overrideVal === undefined) {
      continue;
    }
    const baseVal = result[key];
    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMergeRecords(baseVal, overrideVal);
    } else {
      result[key] = cloneValue(overrideVal);
    }
  }

  return result;
}
