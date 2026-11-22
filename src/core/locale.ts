export const MARKET_VALUES = ['CN', 'GLOBAL'] as const;
export type Market = (typeof MARKET_VALUES)[number];

/**
 * ISO-3166-1 alpha-2 country/region code -> DataForSEO location_code (2000 + ISO numeric).
 * Covers major domestic & global GeoMix markets.
 */
export const REGION_TO_LOCATION_CODE: Readonly<Record<string, number>> = {
  US: 2840,
  GB: 2826,
  DE: 2276,
  JP: 2392,
  CN: 2156,
  FR: 2250,
  CA: 2124,
  AU: 2036,
  SG: 2702,
  HK: 2344,
  TW: 2158,
  KR: 2410,
  ES: 2724,
  IT: 2380,
  NL: 2528,
  BR: 2076,
  IN: 2356,
  MX: 2484,
  SE: 2752,
  CH: 2756,
  ID: 2360,
  TH: 2764,
  VN: 2704,
  MY: 2458,
  PH: 2608,
  AE: 2784,
  SA: 2682,
  NZ: 2554,
  IE: 2372,
  PL: 2616,
};

const LOCATION_CODE_TO_REGION: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(REGION_TO_LOCATION_CODE).map(([iso, code]) => [code, iso]),
);

const REGION_ALIASES: Readonly<Record<string, string>> = {
  UK: 'GB',
};

export function normalizeRegionCode(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return REGION_ALIASES[upper] ?? upper;
}

/**
 * Canonicalizes a BCP-47 locale tag (e.g. `zh_cn` -> `zh-CN`, `en-us` -> `en-US`,
 * `zh-hans-cn` -> `zh-Hans-CN`, `ja` -> `ja`).
 */
export function canonicalizeLocale(raw: string): string {
  const parts = raw
    .trim()
    .split(/[-_]+/)
    .filter((p) => p.length > 0);

  return parts
    .map((part, idx) => {
      if (idx === 0) {
        return part.toLowerCase();
      }
      if (part.length === 4 && /^[A-Za-z]{4}$/.test(part)) {
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }
      if (part.length === 2 && /^[A-Za-z]{2}$/.test(part)) {
        return normalizeRegionCode(part);
      }
      return part;
    })
    .join('-');
}

export interface ParsedLocale {
  locale: string;
  language: string;
  region?: string | undefined;
}

export function parseLocaleParts(rawLocale: string): ParsedLocale {
  const locale = canonicalizeLocale(rawLocale);
  const parts = locale.split('-');
  const language = (parts[0] ?? '').toLowerCase();
  let region: string | undefined;

  for (let i = 1; i < parts.length; i += 1) {
    const seg = parts[i];
    if (seg !== undefined && /^[A-Z]{2}$/.test(seg)) {
      region = normalizeRegionCode(seg);
      break;
    }
  }

  return {
    locale,
    language,
    ...(region !== undefined ? { region } : {}),
  };
}

export function regionToLocationCode(region: string): number | undefined {
  return REGION_TO_LOCATION_CODE[normalizeRegionCode(region)];
}

export function locationCodeToRegion(locationCode: number): string | undefined {
  return LOCATION_CODE_TO_REGION[locationCode];
}

export interface GeoInput {
  market?: Market | undefined;
  locale?: string | undefined;
  region?: string | undefined;
  locationCode?: number | undefined;
  languageCode?: string | undefined;
}

export interface GeoDefaults {
  locationCode: number;
  languageCode: string;
  countryIso: string;
}

export interface ResolvedGeoContext {
  locationCode: number;
  languageCode: string;
  countryIso: string;
  market?: Market | undefined;
  locale?: string | undefined;
  /** Present whenever the caller supplied region, locale (with region), market, or a mapped locationCode. */
  region?: string | undefined;
}

/**
 * Resolves effective locationCode, languageCode, countryIso, locale, market, and region
 * from an incoming collect request while preserving 100% backward compatibility for
 * default calls that omit market/locale/region.
 */
export function resolveGeoContext(input: GeoInput, defaults: GeoDefaults): ResolvedGeoContext {
  const parsedLocale = input.locale !== undefined ? parseLocaleParts(input.locale) : undefined;
  const explicitRegion = input.region !== undefined ? normalizeRegionCode(input.region) : undefined;
  const locationMappedRegion =
    input.locationCode !== undefined ? locationCodeToRegion(input.locationCode) : undefined;

  const derivedRegion =
    explicitRegion ??
    parsedLocale?.region ??
    locationMappedRegion ??
    (input.market === 'CN' ? 'CN' : undefined);

  const countryIso = derivedRegion ?? normalizeRegionCode(defaults.countryIso);

  let locationCode: number;
  if (input.locationCode !== undefined) {
    locationCode = input.locationCode;
  } else if (explicitRegion !== undefined && regionToLocationCode(explicitRegion) !== undefined) {
    locationCode = regionToLocationCode(explicitRegion)!;
  } else if (
    parsedLocale?.region !== undefined &&
    regionToLocationCode(parsedLocale.region) !== undefined
  ) {
    locationCode = regionToLocationCode(parsedLocale.region)!;
  } else if (input.market === 'CN') {
    locationCode = REGION_TO_LOCATION_CODE['CN']!;
  } else {
    locationCode = defaults.locationCode;
  }

  let languageCode: string;
  if (input.languageCode !== undefined) {
    languageCode = input.languageCode;
  } else if (parsedLocale !== undefined && parsedLocale.language.length >= 2) {
    languageCode = parsedLocale.language;
  } else if (input.market === 'CN') {
    languageCode = 'zh';
  } else {
    languageCode = defaults.languageCode;
  }

  return {
    locationCode,
    languageCode,
    countryIso,
    ...(input.market !== undefined ? { market: input.market } : {}),
    ...(parsedLocale !== undefined ? { locale: parsedLocale.locale } : {}),
    ...(derivedRegion !== undefined ? { region: derivedRegion } : {}),
  };
}
