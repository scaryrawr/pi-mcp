/** The searchable fields for an MCP tool. */
export type McpToolSearchCandidate = {
  /** Name of the MCP server that provides the tool. */
  serverName: string;
  /** MCP tool name. */
  toolName: string;
  /** Optional MCP tool description. */
  description?: string;
};

/** A candidate matched against an MCP tool search query. */
export type McpToolMatch = McpToolSearchCandidate & {
  /** Relative match score used to order candidates. */
  score: number;
};

/** Normalizes common English plurals without permitting partial-word matching. */
function singularize(token: string): string {
  if (token.endsWith("ies") && token.length > 3) {
    return `${token.slice(0, -3)}y`;
  }
  if (
    token.endsWith("s") &&
    token.length > 3 &&
    !token.endsWith("ss") &&
    !token.endsWith("us") &&
    !token.endsWith("is")
  ) {
    return token.slice(0, -1);
  }
  return token;
}

/** Splits identifier conventions and prose into normalized, exact-match tokens. */
function tokenize(value: string): string[] {
  return value
    .replaceAll(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean)
    .map(singularize);
}

/**
 * Finds MCP tools matching every plain-text word in a query.
 *
 * Tool and server names are preferred over descriptions. Partial and fuzzy
 * matches are deliberately unsupported to avoid loading unrelated tools.
 */
export function getMcpToolMatches(
  query: string,
  candidates: McpToolSearchCandidate[],
): McpToolMatch[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return [];
  }

  const normalizedQuery = queryTokens.join(" ");
  return candidates
    .map((candidate) => {
      const serverTokens = tokenize(candidate.serverName);
      const toolTokens = tokenize(candidate.toolName);
      const descriptionTokens = tokenize(candidate.description ?? "");
      const identifierTokens = new Set([...serverTokens, ...toolTokens]);
      const searchableTokens = new Set([...identifierTokens, ...descriptionTokens]);

      if (!queryTokens.every((token) => searchableTokens.has(token))) {
        return undefined;
      }

      const exact = normalizedQuery === [...serverTokens, ...toolTokens].join(" ");
      const identifierMatches = queryTokens.filter((token) => identifierTokens.has(token)).length;
      const score = (exact ? 100 : 0) + identifierMatches * 10 + queryTokens.length;
      return { ...candidate, score };
    })
    .filter((match): match is McpToolMatch => match !== undefined)
    .sort((left, right) => right.score - left.score);
}
