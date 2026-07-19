import { describe, expect, it } from "vitest";

import { getMcpToolMatches, type McpToolSearchCandidate } from "./mcp-tool-matching.js";

const tools: McpToolSearchCandidate[] = [
  {
    serverName: "github",
    toolName: "list_pull_requests",
    description: "List pull requests in a repository",
  },
  {
    serverName: "github",
    toolName: "get_pull_request",
    description: "Get a pull request by number",
  },
  {
    serverName: "browser",
    toolName: "captureScreenshot",
    description: "Capture a screenshot of the current page",
  },
];

describe("getMcpToolMatches", () => {
  it("recognizes an exact qualified tool name across naming conventions", () => {
    expect(getMcpToolMatches("github-listPullRequests", tools)).toEqual([
      expect.objectContaining({
        serverName: "github",
        toolName: "list_pull_requests",
      }),
    ]);
  });

  it("requires every query term to match", () => {
    expect(getMcpToolMatches("github pull request", tools)).toHaveLength(2);
    expect(getMcpToolMatches("github pull create", tools)).toEqual([]);
  });

  it("does not treat partial tokens as matches", () => {
    expect(getMcpToolMatches("git", tools)).toEqual([]);
  });

  it("matches capability phrases from descriptions", () => {
    const [match] = getMcpToolMatches("current page", tools);

    expect(match).toMatchObject({ toolName: "captureScreenshot" });
  });
});
