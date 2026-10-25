/**
 * Minimal GitHub REST client — just enough for the submit stage.
 *
 * Argus opens *draft-by-convention* pull requests (title marks them as
 * generated; a human merges). No OAuth dance in the MVP: a classic PAT via
 * `${ARGUS_GITHUB_TOKEN}` env ref, and the repo is taken from the target's
 * `origin` remote (owner/repo parsed from the URL).
 */
import { ArgusError } from "./errors.js";

export class GitHubError extends ArgusError {
  constructor(message: string, readonly status?: number) {
    super(message, "github");
  }
}

export interface GitHubOptions {
  /** Personal access token (fine-grained, repo scope: contents + PRs). */
  token: string;
  /** Override for tests/enterprise (default https://api.github.com). */
  apiBase?: string;
}

export interface PullRequestRef {
  number: number;
  html_url: string;
  title: string;
  /** "open" | "closed" | "draft" */
  state: string;
}

export class GitHub {
  private readonly api: string;

  constructor(private opts: GitHubOptions) {
    this.api = (opts.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  }

  private async request<T>(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.api}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "argus-mvp/0.1",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      throw new GitHubError(`GitHub ${method} ${route} → ${res.status}: ${text}`, res.status);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** `GET /repos/{owner}/{repo}` — verifies access + returns repo facts. */
  async repo(owner: string, repo: string): Promise<{ default_branch: string; full_name: string; html_url: string }> {
    return this.request("GET", `/repos/${owner}/${repo}`);
  }

  /** `POST /repos/{owner}/{repo}/pulls`. */
  async createPullRequest(
    owner: string,
    repo: string,
    input: { base: string; head: string; title: string; body: string },
  ): Promise<PullRequestRef> {
    const data = await this.request<{ number: number; html_url: string; title: string; state: string }>(
      "POST",
      `/repos/${owner}/${repo}/pulls`,
      input,
    );
    return { number: data.number, html_url: data.html_url, title: data.title, state: data.state };
  }
}

/**
 * Parse `owner/repo` from a git remote URL (ssh or https).
 * `git@github.com:owner/repo.git` → ["owner","repo"]; null when unparseable.
 */
export function repoFromRemoteUrl(url: string): [string, string] | null {
  const ssh = url.match(/^git@[^:]+:(.+\/[^/]+?)(?:\.git)?$/);
  if (ssh) return (ssh[1] as string).split("/") as [string, string];
  const https = url.match(/^https?:\/\/[^/]+\/(.+\/[^/]+?)(?:\.git)?$/);
  if (https) return (https[1] as string).split("/") as [string, string];
  return null;
}
