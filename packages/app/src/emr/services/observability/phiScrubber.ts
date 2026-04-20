// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PHI scrubber — browser port of `packages/ml-inference/src/observability/phi_scrubber.py` (T070).
 *
 * Wired into Sentry + PostHog `beforeSend` hooks. Fail-closed per spec
 * FR-029b: if any rule throws, we raise `ScrubberFailure` and the
 * calling hook MUST drop the event (return null) rather than send it.
 *
 * Plain-English analogy:
 *   A shredder at the outbox. Every event is passed through — names,
 *   patient IDs, emails are blacked out. If the shredder jams, the
 *   outbox throws the envelope away. Better to lose a crash report
 *   than leak PHI.
 *
 * TODO(sync): keep in sync with the Python scrubber. The name lists +
 * regexes below are deliberately identical to their Python cousins.
 * A future codegen step should derive both from a shared JSON source.
 */

export class ScrubberFailure extends Error {
  override readonly name = 'ScrubberFailure';
}

export const REDACTION = '[redacted]' as const;

/** Fields whose values pass through unchanged. Matches `SAFE_FIELD_NAMES` in Python. */
export const SAFE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'analysis_id',
  'correlation_id',
  'error_code',
  'error_slug',
  'event_type',
  'leaf_hash',
  'level',
  'model_version',
  'pipeline_stage',
  'prev_leaf_hash',
  'request_id',
  'sequence_no',
  'series_instance_uid',
  'sop_instance_uid',
  'stage',
  'study_instance_uid',
  'tenant_id',
  'timestamp',
  'trace_id',
  'transaction_uid',
  'user_role',
]);

// Regexes — keep mirror-identical to the Python tree.
const DICOM_UID_RE = /\b(?:\d+\.){8,}\d+\b/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const MRN_LABEL_RE =
  /\b(?:MRN|Patient\s*ID|PatientID|Patient\s*No\.?|Pat\.?\s*Nr\.?|Chart\s*No\.?|Medical\s*Record\s*Number)\s*[:#]?\s*[A-Z0-9\-/]{3,}/gi;
const BARE_MRN_RE = /\b\d{6,10}\b/g;

/**
 * PARTIAL LIST — production deployment should load full list from tenant config.
 * German top-50 given + family names (Destatis 2023, Deutsche Post Namensforschung).
 */
export const GERMAN_NAMES: readonly string[] = [
  // Given
  'Alexander', 'Andreas', 'Benjamin', 'Christian', 'Daniel',
  'David', 'Dennis', 'Dominik', 'Felix', 'Florian',
  'Hans', 'Jakob', 'Jan', 'Johannes', 'Jonas',
  'Julian', 'Kevin', 'Leon', 'Lukas', 'Markus',
  'Martin', 'Matthias', 'Maximilian', 'Michael', 'Niklas',
  'Paul', 'Peter', 'Philipp', 'Sebastian', 'Simon',
  'Stefan', 'Thomas', 'Tim', 'Tobias',
  'Anna', 'Elena', 'Emma', 'Hannah', 'Johanna',
  'Julia', 'Katharina', 'Laura', 'Lea', 'Lena',
  'Lisa', 'Maria', 'Marie', 'Nina', 'Petra',
  'Sabine', 'Sarah', 'Sophie', 'Stefanie',
  // Family
  'Müller', 'Mueller', 'Schmidt', 'Schneider', 'Fischer',
  'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz',
  'Hoffmann', 'Schäfer', 'Schaefer', 'Koch', 'Bauer',
  'Richter', 'Klein', 'Wolf', 'Schröder', 'Schroeder',
  'Neumann', 'Schwarz', 'Zimmermann', 'Braun', 'Krüger',
  'Krueger', 'Hofmann', 'Hartmann', 'Lange', 'Werner',
  'Schmitz', 'Krause', 'Meier', 'Lehmann', 'Schmid',
  'Schulze', 'Maier', 'Köhler', 'Koehler', 'Herrmann',
  'König', 'Koenig', 'Walter', 'Mayer', 'Huber',
  'Kaiser', 'Fuchs', 'Peters', 'Lang', 'Scholz',
  'Möller', 'Moeller', 'Weiß', 'Weiss', 'Jung',
  'Hahn', 'Schubert', 'Özdemir', 'Oezdemir',
];

/**
 * PARTIAL LIST — production deployment should load full list from tenant config.
 * Georgian given + family names in Latin transliteration AND native script.
 */
export const GEORGIAN_NAMES: readonly string[] = [
  // Latin
  'Giorgi', 'Davit', 'Irakli', 'Levan', 'Zviad',
  'Nika', 'Lasha', 'Vakhtang', 'Tornike', 'Mikheil',
  'Nodar', 'Shota', 'Otar', 'Zurab', 'Revaz',
  'Beka', 'Sandro', 'Luka',
  'Nino', 'Tamar', 'Mariam', 'Ana', 'Salome',
  'Lika', 'Elene', 'Natia', 'Ketevan', 'Tamta',
  'Mzia', 'Manana',
  'Gogichaishvili', 'Giorgadze', 'Svanadze', 'Japaridze',
  'Beridze', 'Kapanadze', 'Tsereteli', 'Kiknadze',
  'Chavchavadze', 'Saakashvili', 'Gelashvili', 'Lomidze',
  'Khutsishvili', 'Meladze', 'Tabatadze', 'Gurgenidze',
  'Kakabadze', 'Lortkipanidze', 'Dolidze', 'Nadiradze',
  'Chkheidze', 'Tevzadze', 'Khelaia', 'Kvaratskhelia',
  // Georgian script
  'გიორგი', 'დავით', 'ირაკლი', 'ლევან', 'ზვიად',
  'ნიკა', 'ლაშა', 'ვახტანგ', 'თორნიკე', 'მიხეილ',
  'ნინო', 'თამარ', 'მარიამ', 'ანა', 'სალომე',
  'ლიკა', 'ელენე', 'ნათია', 'ქეთევან',
  'გოგიჩაიშვილი', 'გიორგაძე', 'სვანაძე', 'ჯაფარიძე',
  'ბერიძე', 'კაპანაძე', 'წერეთელი', 'კიკნაძე',
  'ჭავჭავაძე', 'სააკაშვილი', 'გელაშვილი', 'ლომიძე',
];

// Pre-compute a longest-first name list so multi-token names (e.g.
// "Meyer-Schulze") are caught before single tokens that would shadow them.
const NAME_LIST: readonly string[] = [...new Set([...GERMAN_NAMES, ...GEORGIAN_NAMES])]
  .sort((a, b) => b.length - a.length);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrub a string of PHI (names, MRNs, emails, DICOM UIDs).
 * Throws `ScrubberFailure` if any rule crashes — caller MUST drop the event.
 */
export function scrubString(input: string): string {
  try {
    if (!input) return input;

    let out = input;

    // 1. DICOM UIDs.
    out = out.replace(DICOM_UID_RE, REDACTION);

    // 2. MRN labels.
    out = out.replace(MRN_LABEL_RE, REDACTION);

    // 3. Emails.
    out = out.replace(EMAIL_RE, REDACTION);

    // 4. Bare MRN-shaped digit runs.
    out = out.replace(BARE_MRN_RE, REDACTION);

    // 5. Names — longest-first linear scan with word-boundary check.
    for (const name of NAME_LIST) {
      if (!out.includes(name)) continue;
      // Word boundaries: previous + next char must be non-letter.
      out = replaceWithWordBoundary(out, name, REDACTION);
    }

    return out;
  } catch (err) {
    throw new ScrubberFailure(
      `phi_scrubber.scrubString failed: ${(err as Error)?.message ?? String(err)}`,
    );
  }
}

/** Deep-clone + scrub an arbitrary object graph. Fail-closed. */
export function scrubObject<T>(input: T): T {
  try {
    return walk(input, undefined) as T;
  } catch (err) {
    if (err instanceof ScrubberFailure) throw err;
    throw new ScrubberFailure(
      `phi_scrubber.scrubObject failed: ${(err as Error)?.message ?? String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function walk(node: unknown, parentKey: string | undefined): unknown {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map((v) => walk(v, parentKey));
  if (typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = walk(v, k);
    }
    return out;
  }
  if (typeof node === 'string') {
    if (parentKey !== undefined && SAFE_FIELD_NAMES.has(parentKey)) {
      return node;
    }
    return scrubString(node);
  }
  return node;
}

/**
 * Replace every occurrence of `needle` in `haystack` with `replacement`,
 * but only when bounded by non-letter characters (Unicode-aware).
 */
function replaceWithWordBoundary(
  haystack: string,
  needle: string,
  replacement: string,
): string {
  let out = '';
  let i = 0;
  while (i < haystack.length) {
    const j = haystack.indexOf(needle, i);
    if (j < 0) {
      out += haystack.slice(i);
      break;
    }
    const prevChar = j === 0 ? '' : haystack[j - 1];
    const nextChar = haystack[j + needle.length] ?? '';
    const prevOk = !prevChar || !isLetter(prevChar);
    const nextOk = !nextChar || !isLetter(nextChar);
    if (prevOk && nextOk) {
      out += haystack.slice(i, j) + replacement;
      i = j + needle.length;
    } else {
      out += haystack.slice(i, j + 1);
      i = j + 1;
    }
  }
  return out;
}

function isLetter(ch: string): boolean {
  // Unicode property escape — letter OR combining mark (Georgian + German-diacritics aware).
  return /\p{L}|\p{M}/u.test(ch);
}

export default { scrubString, scrubObject, ScrubberFailure };
