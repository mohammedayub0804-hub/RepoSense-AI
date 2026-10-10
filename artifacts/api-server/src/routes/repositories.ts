import { Router, type IRouter } from "express";
import {
  AnalyzeRepositoryParams,
  AnalyzeRepositoryResponse,
} from "@workspace/api-zod";

type GitHubRepository = {
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  subscribers_count: number;
  default_branch: string;
  updated_at: string;
  license: { spdx_id?: string | null; name?: string | null } | null;
  language: string | null;
};

type GitHubContent = {
  name: string;
  path: string;
  type: "file" | "dir";
  html_url: string;
};

type GitHubError = {
  message?: string;
};

const router: IRouter = Router();
const githubHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "RepoSense-AI",
  "X-GitHub-Api-Version": "2022-11-28",
};

class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimited: boolean,
  ) {
    super(message);
  }
}

async function githubGet<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: githubHeaders,
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as GitHubError;
      message = body.message ?? message;
    } catch {
      // Keep the HTTP status text when GitHub returns a non-JSON error.
    }

    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          message.toLowerCase().includes("rate limit")));

    throw new GitHubRequestError(message, response.status, rateLimited);
  }

  return (await response.json()) as T;
}

function createOverview(
  repo: GitHubRepository,
  languages: { name: string; percentage: number }[],
  items: GitHubContent[],
): string {
  const description = repo.description?.trim();
  const language = repo.language ?? languages[0]?.name;
  const hasReadme = items.some((item) => /^readme(?:\.|$)/i.test(item.name));
  const sourceDirectory = items.find((item) =>
    /^(src|app|lib|packages)$/i.test(item.name),
  );

  const sentences = [
    description
      ? description
      : `${repo.name} is a public repository owned by ${repo.owner.login}.`,
    language
      ? `Its primary language is ${language}${languages.length > 1 ? `, with ${languages.length - 1} other detected language${languages.length === 2 ? "" : "s"}` : ""}.`
      : "GitHub has not reported a primary programming language for this repository.",
    `This map highlights ${items.length} notable root item${items.length === 1 ? "" : "s"}${hasReadme ? ", including a README" : ""}${sourceDirectory ? ` and a ${sourceDirectory.name} source directory` : ""}.`,
    `It has ${repo.stargazers_count.toLocaleString("en-US")} star${repo.stargazers_count === 1 ? "" : "s"} and uses the ${repo.default_branch} default branch.`,
  ];

  return sentences.join(" ");
}

const importanceLabels: Record<string, string> = {
  readme: "Project documentation",
  "package.json": "Node.js project manifest",
  "pnpm-workspace.yaml": "Workspace configuration",
  "pyproject.toml": "Python project manifest",
  "requirements.txt": "Python dependencies",
  "cargo.toml": "Rust project manifest",
  "go.mod": "Go module definition",
  "pom.xml": "Java project manifest",
  "build.gradle": "Build configuration",
  "dockerfile": "Container build instructions",
  "docker-compose.yml": "Container services",
  "license": "License information",
  "contributing.md": "Contribution guidelines",
  "makefile": "Build and task commands",
};

function getImportance(item: GitHubContent): string {
  const lowerName = item.name.toLowerCase();
  const directLabel = importanceLabels[lowerName];
  if (directLabel) return directLabel;
  if (/^readme\./.test(lowerName)) return "Project documentation";
  if (item.type === "dir" && /^(src|app|lib|packages)$/.test(lowerName)) {
    return "Application source code";
  }
  if (item.type === "dir" && /^(test|tests|spec|__tests__)$/.test(lowerName)) {
    return "Tests";
  }
  if (item.type === "dir" && /^(docs|documentation)$/.test(lowerName)) {
    return "Documentation";
  }
  if (item.type === "dir") return "Top-level folder";
  if (/\.(ya?ml|toml|json)$/.test(lowerName)) return "Project configuration";
  return "Top-level file";
}

const priorityItems = [
  "readme",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "src",
  "app",
  "lib",
  "packages",
  "tests",
  "test",
  "docs",
  "license",
  "contributing.md",
];

router.get(
  "/repositories/:owner/:repo",
  async (req, res): Promise<void> => {
    const params = AnalyzeRepositoryParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({
        error: "Enter a valid GitHub owner and repository name.",
        code: "INVALID_REPOSITORY",
      });
      return;
    }

    const { owner, repo } = params.data;
    if (
      !/^[A-Za-z0-9-]{1,39}$/.test(owner) ||
      !/^[A-Za-z0-9_.-]{1,100}$/.test(repo) ||
      repo === "." ||
      repo === ".."
    ) {
      res.status(400).json({
        error: "Enter a valid GitHub owner and repository name.",
        code: "INVALID_REPOSITORY",
      });
      return;
    }

    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    try {
      const repository = await githubGet<GitHubRepository>(base);

      const [rawLanguages, rawItems] = await Promise.all([
        githubGet<Record<string, number>>(`${base}/languages`),
        githubGet<GitHubContent[]>(base + "/contents").catch((error: unknown) => {
          if (error instanceof GitHubRequestError && error.status === 404) {
            return [];
          }
          throw error;
        }),
      ]);

      const totalLanguageBytes = Object.values(rawLanguages).reduce(
        (sum, bytes) => sum + bytes,
        0,
      );
      const languages = Object.entries(rawLanguages)
        .sort(([, left], [, right]) => right - left)
        .map(([name, bytes]) => ({
          name,
          bytes,
          percentage:
            totalLanguageBytes > 0
              ? Math.round((bytes / totalLanguageBytes) * 1000) / 10
              : 0,
        }));

      const rankedItems = rawItems
        .filter(
          (item): item is GitHubContent =>
            typeof item?.name === "string" &&
            typeof item?.path === "string" &&
            (item.type === "file" || item.type === "dir") &&
            typeof item?.html_url === "string",
        )
        .sort((left, right) => {
          const leftPriority = priorityItems.indexOf(left.name.toLowerCase());
          const rightPriority = priorityItems.indexOf(right.name.toLowerCase());
          const leftRank = leftPriority === -1 ? priorityItems.length : leftPriority;
          const rightRank = rightPriority === -1 ? priorityItems.length : rightPriority;
          return leftRank - rightRank || left.name.localeCompare(right.name);
        })
        .slice(0, 12);

      const analysis = AnalyzeRepositoryResponse.parse({
        owner: repository.owner.login,
        name: repository.name,
        fullName: repository.full_name,
        description: repository.description,
        htmlUrl: repository.html_url,
        stars: repository.stargazers_count,
        forks: repository.forks_count,
        watchers: repository.subscribers_count,
        defaultBranch: repository.default_branch,
        updatedAt: repository.updated_at,
        license:
          repository.license?.spdx_id ?? repository.license?.name ?? null,
        primaryLanguage: repository.language ?? languages[0]?.name ?? null,
        languages,
        importantItems: rankedItems.map((item) => ({
          name: item.name,
          path: item.path,
          type: item.type === "dir" ? "directory" : "file",
          htmlUrl: item.html_url,
          importance: getImportance(item),
        })),
        overview: createOverview(repository, languages, rankedItems),
      });

      res.json(analysis);
    } catch (error) {
      if (error instanceof GitHubRequestError) {
        if (error.rateLimited) {
          res.status(429).json({
            error:
              "GitHub’s public API limit has been reached. Please wait a minute and try again.",
            code: "GITHUB_RATE_LIMIT",
          });
          return;
        }
        if (error.status === 404) {
          res.status(404).json({
            error:
              "Repository not found. Check the owner and repository name, and make sure it is public.",
            code: "REPOSITORY_NOT_FOUND",
          });
          return;
        }
        req.log.warn(
          { status: error.status, owner, repo },
          "GitHub repository request failed",
        );
        res.status(502).json({
          error: "GitHub could not complete the request. Please try again.",
          code: "GITHUB_REQUEST_FAILED",
        });
        return;
      }

      req.log.error({ err: error, owner, repo }, "Repository analysis failed");
      res.status(502).json({
        error:
          "Could not reach GitHub right now. Check your connection and try again.",
        code: "GITHUB_NETWORK_ERROR",
      });
    }
  },
);

export default router;
