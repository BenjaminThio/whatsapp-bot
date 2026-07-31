// Each inner array is one equivalence group - all codes in it are "the same class".
// Add more groups / codes as you discover them.
const EQUIVALENCE_GROUPS: string[][] = [
  ["UECS2033", "EECS2033"],
  ["UECS2194", "EECS2194", "UECS2094"],
  ["UECS2344", "EECS2344"],
  ["UECS2354", "EECS2354"],
  ["UECS2403", "UECS2423", "UECS2103"]
];

// Build a lookup: code => canonical code (the first code in its group).
const CANONICAL: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const group of EQUIVALENCE_GROUPS) {
    const canonical = group[0].toUpperCase();
    for (const code of group) map[code.toUpperCase()] = canonical;
  }
  return map;
})();

/**
 * Normalise a course code to its canonical form. Codes not in any equivalence
 * group return unchanged (just uppercased/trimmed).
 */
export function canonicalCode(code: string | null | undefined): string {
  const c = (code ?? "").toUpperCase().trim();
  return CANONICAL[c] ?? c;
}

/** True if two course codes refer to the same class (directly or via a group). */
export function sameCourse(a: string | null | undefined, b: string | null | undefined): boolean {
  return canonicalCode(a) === canonicalCode(b);
}