const PAGE_TOKEN_PATTERN = /^\d+$/;

/**
 * Parse a reviewer's comma-separated, one-based PDF page references into the
 * canonical representation accepted by the server and signed evidence bundle.
 */
export function parseEndorsementSourcePages(
  value: string,
  options: { required: boolean; maxPage?: number | null },
): number[] | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    if (options.required) {
      throw new Error("Attached or human-verified endorsement evidence needs a source page.");
    }
    return undefined;
  }

  const tokens = trimmed.split(",").map((token) => token.trim());
  if (tokens.some((token) => !PAGE_TOKEN_PATTERN.test(token))) {
    throw new Error("Endorsement source pages must be comma-separated whole page numbers.");
  }
  const pages = tokens.map(Number);
  if (pages.length > 100) throw new Error("An endorsement can reference at most 100 pages.");
  const maxPage = options.maxPage ?? 100;
  if (pages.some((page) => page < 1 || page > maxPage)) {
    throw new Error(`Endorsement source pages must be between 1 and ${maxPage}.`);
  }
  if (new Set(pages).size !== pages.length) {
    throw new Error("An endorsement source page cannot be repeated.");
  }
  return pages.sort((left, right) => left - right);
}

export const endorsementSourcePagesText = (pages?: readonly number[]): string =>
  pages?.join(", ") ?? "";
