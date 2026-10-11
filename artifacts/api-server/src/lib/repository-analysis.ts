import { AnalyzeRepositoryResponse } from "@workspace/api-zod";

type GitHubRepository = {
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  subscribers_count: number;
  default_branch: string | null;
  updated_at: string;
  license: { spdx_id?: string | null; name?: string | null } | null;
  language: string | null;
};

type GitHubTreeNode = {
  path: string;
  type: "blob" | "tree" | "commit";
  sha?: string;
  size?: number;
};

type GitHubTree = {
  tree: GitHubTreeNode[];
  truncated: boolean;
};

type GitHubBlob = {
  content?: string;
  encoding?: string;
};

type GitHubError = {
  message?: string;
};

type RetrievedRepositoryFile = {
  path: string;
  text: string;
  contentSummary: string;
};

type RepositoryAnalysisData = ReturnType<typeof AnalyzeRepositoryResponse.parse>;

type CachedRepositoryEvidence = {
  cachedAt: number;
  analysis: RepositoryAnalysisData;
  treeNodes: GitHubTreeNode[];
  files: Map<string, RetrievedRepositoryFile>;
};

export type RepositoryExplanationEvidence = {
  analysis: RepositoryAnalysisData;
  files: RetrievedRepositoryFile[];
  unavailablePaths: string[];
};

const evidenceCache = new Map<string, CachedRepositoryEvidence>();
const evidenceCacheTtlMs = 10 * 60 * 1000;
const maxCachedRepositories = 30;
const maxRetrievedFileBytes = 80_000;
const githubRequestWindowMs = 60 * 60 * 1000;
const maxGithubRequestsPerWindow = 50;
const githubRequestTimestamps: number[] = [];

export class GitHubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rateLimited: boolean,
  ) {
    super(message);
  }
}

function consumeGithubRequestBudget(): void {
  const now = Date.now();
  while (
    githubRequestTimestamps.length > 0 &&
    now - githubRequestTimestamps[0] >= githubRequestWindowMs
  ) {
    githubRequestTimestamps.shift();
  }
  if (githubRequestTimestamps.length >= maxGithubRequestsPerWindow) {
    throw new GitHubRequestError(
      "RepoSense has reached its hourly public GitHub API request budget.",
      429,
      true,
    );
  }
  githubRequestTimestamps.push(now);
}

const githubHeaders = {
  Accept: "application/vnd.github+json",
  "User-Agent": "RepoSense-AI",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function githubGet<T>(url: string): Promise<T> {
  consumeGithubRequestBudget();
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

const filePurposeNames: Record<string, string> = {
  "readme": "Likely project guide",
  "package.json": "Likely JavaScript project manifest",
  "requirements.txt": "Likely Python dependency list",
  "pyproject.toml": "Likely Python project configuration",
  "cargo.toml": "Likely Rust project manifest",
  "go.mod": "Likely Go module definition",
  "pom.xml": "Likely Java project manifest",
  "build.gradle": "Likely Java or Android build configuration",
  "composer.json": "Likely PHP project manifest",
  "gemfile": "Likely Ruby dependency list",
  "license": "Likely license terms",
  "contributing.md": "Likely contribution guide",
  "dockerfile": "Likely container build instructions",
};

const contentCandidates = [
  /^readme(?:\.|$)/i,
  /^package\.json$/i,
  /^requirements(?:[-.]?.*)?\.txt$/i,
  /^pyproject\.toml$/i,
  /^cargo\.toml$/i,
  /^go\.mod$/i,
  /^pom\.xml$/i,
  /^build\.gradle(?:\.kts)?$/i,
  /^composer\.json$/i,
  /^gemfile$/i,
];

const manifestPriorityByLanguage: Record<string, string[]> = {
  javascript: ["package.json"],
  typescript: ["package.json"],
  python: ["pyproject.toml", "requirements.txt"],
  rust: ["cargo.toml"],
  go: ["go.mod"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts"],
  php: ["composer.json"],
  ruby: ["gemfile"],
};

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function getPathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

const sourceExtensions =
  /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|mjs|php|py|rb|rs|sh|swift|ts|tsx|vue)$/i;
const sourceDirectoryNames = new Set([
  "app",
  "cmd",
  "internal",
  "lib",
  "packages",
  "source",
  "src",
]);
const excludedSourceDirectoryNames = new Set([
  ".git",
  "build",
  "coverage",
  "dist",
  "examples",
  "fixtures",
  "node_modules",
  "spec",
  "test",
  "tests",
  "vendor",
]);

function isSourceCandidate(node: GitHubTreeNode): boolean {
  if (node.type !== "blob" || !node.sha || !sourceExtensions.test(node.path)) {
    return false;
  }
  const segments = node.path.split("/").map((segment) => segment.toLowerCase());
  return !segments.some((segment) => excludedSourceDirectoryNames.has(segment));
}

function isLikelyEntryPoint(node: GitHubTreeNode): boolean {
  const name = basename(node.path).replace(sourceExtensions, "").toLowerCase();
  return ["index", "main", "app", "server", "application", "router", "cli"].includes(name);
}

function sourceCandidateRank(node: GitHubTreeNode): number {
  const basenameWithoutExtension = basename(node.path)
    .replace(sourceExtensions, "")
    .toLowerCase();
  const entryPointOrder = [
    "index",
    "main",
    "app",
    "server",
    "application",
    "router",
    "cli",
  ];
  const rank = entryPointOrder.indexOf(basenameWithoutExtension);
  const hasSourceDirectory = node.path
    .split("/")
    .slice(0, -1)
    .some((segment) => sourceDirectoryNames.has(segment.toLowerCase()));
  return (
    (rank < 0 ? entryPointOrder.length : rank) * 100 +
    (hasSourceDirectory ? 0 : 30) +
    Math.min(getPathDepth(node.path), 20)
  );
}

function isImportantNode(node: GitHubTreeNode): boolean {
  const name = basename(node.path).toLowerCase();
  if (node.type === "tree") {
    return /^(src|app|lib|packages|source|cmd|internal|tests?|__tests__|spec|docs|documentation)$/.test(
      name,
    );
  }
  return (
    Object.keys(filePurposeNames).includes(name) ||
    /^readme(?:\.|$)/i.test(name) ||
    /^requirements(?:[-.]?.*)?\.txt$/i.test(name) ||
    /^pyproject\.toml$/i.test(name) ||
    /^build\.gradle(?:\.kts)?$/i.test(name) ||
    (isSourceCandidate(node) && isLikelyEntryPoint(node))
  );
}

function getEstimatedPurpose(path: string, type: "file" | "directory" | "submodule"): string {
  if (type === "submodule") return "Likely linked external repository";
  const name = basename(path).toLowerCase();

  if (type === "directory") {
    if (/^(src|app|lib|packages|source|cmd|internal)$/.test(name)) {
      return "Likely source-code folder";
    }
    if (/^(test|tests|__tests__|spec)$/.test(name)) {
      return "Likely test folder";
    }
    if (/^(docs|documentation)$/.test(name)) {
      return "Likely documentation folder";
    }
    return "Folder; role estimated from its name";
  }

  if (sourceExtensions.test(name)) {
    return isLikelyEntryPoint({ path, type: "blob", sha: "" })
      ? "Likely application entry point; estimated from its name"
      : "Source-code file; role estimated from its path";
  }

  return (
    filePurposeNames[name] ??
    (/^readme(?:\.|$)/i.test(name)
      ? "Likely project guide"
      : /^requirements(?:[-.]?.*)?\.txt$/i.test(name)
        ? "Likely Python dependency list"
        : /\.(ya?ml|toml|json|ini|conf)$/.test(name)
          ? "Likely configuration file"
          : "File; role estimated from its name")
  );
}

function selectContentNodes(
  nodes: GitHubTreeNode[],
  primaryLanguage: string | null,
): GitHubTreeNode[] {
  const files = nodes.filter(
    (node) => node.type === "blob" && node.sha && contentCandidates.some((pattern) => pattern.test(basename(node.path))),
  );
  const readmes = files
    .filter((node) => /^readme(?:\.|$)/i.test(basename(node.path)))
    .sort((a, b) => getPathDepth(a.path) - getPathDepth(b.path) || a.path.localeCompare(b.path));

  const preferredNames = manifestPriorityByLanguage[primaryLanguage?.toLowerCase() ?? ""] ?? [];
  const manifests = files
    .filter((node) => !/^readme(?:\.|$)/i.test(basename(node.path)))
    .sort((a, b) => {
      const aName = basename(a.path).toLowerCase();
      const bName = basename(b.path).toLowerCase();
      const aPreference = preferredNames.indexOf(aName);
      const bPreference = preferredNames.indexOf(bName);
      const aRank = aPreference < 0 ? preferredNames.length : aPreference;
      const bRank = bPreference < 0 ? preferredNames.length : bPreference;
      return (
        aRank - bRank ||
        getPathDepth(a.path) - getPathDepth(b.path) ||
        a.path.localeCompare(b.path)
      );
    });
  const uniqueManifests: GitHubTreeNode[] = [];
  const seenManifestNames = new Set<string>();
  for (const manifest of manifests) {
    const manifestName = basename(manifest.path).toLowerCase();
    if (seenManifestNames.has(manifestName)) continue;
    seenManifestNames.add(manifestName);
    uniqueManifests.push(manifest);
  }
  const sourceFiles = nodes
    .filter(isSourceCandidate)
    .sort(
      (left, right) =>
        sourceCandidateRank(left) - sourceCandidateRank(right) ||
        left.path.localeCompare(right.path),
    );

  // Keep the public unauthenticated GitHub API request budget predictable.
  return [
    ...readmes.slice(0, 1),
    ...uniqueManifests.slice(0, 2),
    ...sourceFiles.slice(0, 2),
  ];
}

function cleanText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function readmeExcerpt(text: string, maxLength: number): string {
  const contentsHeading = text.search(
    /^\s*#{1,6}\s*(?:table of )?contents\s*#*\s*$/im,
  );
  const introduction =
    contentsHeading >= 0 ? text.slice(0, contentsHeading) : text;
  const excerpt = cleanText(introduction || text).slice(0, maxLength);
  return `${excerpt}${excerpt.length === maxLength ? "…" : ""}`;
}

function listRequirements(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("-"))
    .map((line) => line.split(/[<>=!~;\s[]/, 1)[0])
    .filter(Boolean);
}

function summarizeRetrievedFile(path: string, text: string): string {
  const name = basename(path).toLowerCase();
  if (/^readme(?:\.|$)/i.test(name)) {
    const excerpt = readmeExcerpt(text, 300);
    return excerpt
      ? `README excerpt: ${excerpt}`
      : "README content was retrieved, but no readable introductory text was found.";
  }

  if (name === "package.json") {
    try {
      const manifest = JSON.parse(text) as {
        name?: string;
        description?: string;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
        scripts?: Record<string, unknown>;
      };
      const dependencies = [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ];
      const scripts = Object.keys(manifest.scripts ?? {});
      const details = [
        manifest.name ? `Package name: ${manifest.name}.` : "",
        manifest.description ? `Description: ${manifest.description}.` : "",
        dependencies.length
          ? `${dependencies.length} dependency names were found${dependencies.length <= 6 ? `: ${dependencies.join(", ")}` : `, including ${dependencies.slice(0, 6).join(", ")}`}.`
          : "No dependencies were listed.",
        scripts.length ? `Script names include ${scripts.slice(0, 5).join(", ")}.` : "",
      ].filter(Boolean);
      return details.join(" ");
    } catch {
      return "package.json was retrieved, but it could not be summarized as valid JSON.";
    }
  }

  if (/^requirements(?:[-.]?.*)?\.txt$/i.test(name)) {
    const packages = listRequirements(text);
    return packages.length
      ? `Retrieved dependency list: ${packages.slice(0, 8).join(", ")}${packages.length > 8 ? `, and ${packages.length - 8} more` : ""}.`
      : "The requirements file was retrieved, but no package entries were found.";
  }

  if (name === "pyproject.toml") {
    const projectName = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
    const projectDescription = text.match(/^\s*description\s*=\s*["']([^"']+)["']/m)?.[1];
    const dependencyBlock = text.match(
      /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m,
    )?.[1];
    const dependencies = dependencyBlock
      ? [...dependencyBlock.matchAll(/["']([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?/g)]
          .map((match) => match[1])
          .slice(0, 8)
      : [];
    const details = [
      projectName ? `Project name: ${projectName}.` : "",
      projectDescription ? `Description: ${projectDescription}.` : "",
      dependencies.length ? `Dependency names found: ${[...new Set(dependencies)].join(", ")}.` : "",
    ].filter(Boolean);
    return details.length
      ? details.join(" ")
      : "pyproject.toml was retrieved; its project metadata could not be summarized automatically.";
  }

  if (name === "cargo.toml") {
    const projectName = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
    const dependencies = [...text.matchAll(/^\[dependencies\.([^\]]+)\]/gm)]
      .map((match) => match[1])
      .slice(0, 8);
    const details = [
      projectName ? `Package name: ${projectName}.` : "",
      dependencies.length ? `Dependency sections include ${dependencies.join(", ")}.` : "",
    ].filter(Boolean);
    return details.length
      ? details.join(" ")
      : "Cargo.toml was retrieved; no package name or dependency sections were summarized.";
  }

  if (name === "go.mod") {
    const modulePath = text.match(/^\s*module\s+(\S+)/m)?.[1];
    const dependencies = [...text.matchAll(/^\s*([A-Za-z0-9._/-]+)\s+v[^\s]+/gm)]
      .map((match) => match[1])
      .slice(0, 8);
    const details = [
      modulePath ? `Module path: ${modulePath}.` : "",
      dependencies.length ? `Dependency modules include ${dependencies.join(", ")}.` : "",
    ].filter(Boolean);
    return details.length
      ? details.join(" ")
      : "go.mod was retrieved; its module details could not be summarized automatically.";
  }

  if (sourceExtensions.test(name)) {
    return "Source file contents were retrieved; automatic source-code summaries are not generated here.";
  }

  return `${basename(path)} was retrieved, but this manifest type has no summary parser yet.`;
}

function detectTechnologyStack(
  languageEntries: { name: string; bytes: number }[],
  retrievedFiles: { path: string; text: string }[],
): string[] {
  const languages = languageEntries.slice(0, 6).map((language) => language.name);
  const evidenceText = retrievedFiles.map((file) => file.text.toLowerCase()).join("\n");
  const frameworkSignals: [RegExp, string][] = [
    [/"name"\s*:\s*"express"/, "Express"],
    [/"name"\s*:\s*"next"/, "Next.js"],
    [/"name"\s*:\s*"vite"/, "Vite"],
    [/"name"\s*:\s*"react"/, "React"],
    [/"react"\s*:|^react\s*[<>=!~]/m, "React"],
    [/"next"\s*:|^next\s*[<>=!~]/m, "Next.js"],
    [/"vite"\s*:|^vite\s*[<>=!~]/m, "Vite"],
    [/"express"\s*:|^express\s*[<>=!~]/m, "Express"],
    [/"vue"\s*:|^vue\s*[<>=!~]/m, "Vue"],
    [/"@angular\/core"\s*:|^angular\s*[<>=!~]/m, "Angular"],
    [/"svelte"\s*:|^svelte\s*[<>=!~]/m, "Svelte"],
    [/"tailwindcss"\s*:|^tailwindcss\s*[<>=!~]/m, "Tailwind CSS"],
    [/\bfastapi\b/, "FastAPI"],
    [/\bflask\b/, "Flask"],
    [/\bdjango\b/, "Django"],
    [/\bpytest\b/, "pytest"],
    [/\bspring-boot\b/, "Spring Boot"],
    [/\blaravel\b/, "Laravel"],
  ];
  const detected = frameworkSignals
    .filter(([pattern]) => pattern.test(evidenceText))
    .map(([, technology]) => technology);
  return [...new Set([...languages, ...detected])];
}

function purposeEstimate(
  repository: GitHubRepository,
  retrievedFiles: { path: string; text: string }[],
): string {
  const readme = retrievedFiles.find((file) => /^readme(?:\.|$)/i.test(basename(file.path)));
  const description = repository.description?.trim();
  if (description && readme) {
    return `Estimate based on GitHub's repository description and the retrieved README introduction: ${description} README introduction: ${readmeExcerpt(readme.text, 220)}`;
  }
  if (description) {
    return `Estimate based on GitHub's repository description: ${description}`;
  }
  if (readme) {
    const excerpt = readmeExcerpt(readme.text, 220);
    if (excerpt) return `Estimate based on the retrieved README excerpt: ${excerpt}`;
  }
  return "There is not enough repository description or retrieved documentation to estimate the project's purpose.";
}

function createOverview(
  repository: GitHubRepository,
  languages: { name: string; percentage: number }[],
  retrievedFiles: { path: string; text: string }[],
  treeEntryCount: number,
): string {
  const primaryLanguage =
    repository.language ?? languages[0]?.name ?? "not reported";
  const readme = retrievedFiles.find((file) => /^readme(?:\.|$)/i.test(basename(file.path)));
  const parts = [
    repository.description
      ? `GitHub's repository description: ${repository.description}`
      : "GitHub has not provided a repository description.",
    `GitHub reports ${primaryLanguage} as the primary language${languages.length > 1 ? `, with ${languages.length} languages detected in total` : ""}.`,
    readme
      ? `A short excerpt from the retrieved ${basename(readme.path)}: ${readmeExcerpt(readme.text, 220)}`
      : "No README contents were retrieved for this overview.",
    `GitHub's recursive file tree returned ${treeEntryCount.toLocaleString("en-US")} entries.`,
  ];
  return parts.join(" ");
}

function contentPathPriority(node: GitHubTreeNode): number {
  const name = basename(node.path).toLowerCase();
  const index = contentCandidates.findIndex((pattern) => pattern.test(name));
  if (index >= 0) return index;
  return isLikelyEntryPoint(node)
    ? contentCandidates.length + sourceCandidateRank(node)
    : contentCandidates.length + 100;
}

export async function analyzeGitHubRepository(owner: string, repo: string) {
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const repository = await githubGet<GitHubRepository>(base);
  const [rawLanguages, treeResponse] = await Promise.all([
    githubGet<Record<string, number>>(`${base}/languages`),
    repository.default_branch
      ? githubGet<GitHubTree>(
          `${base}/git/trees/${encodeURIComponent(repository.default_branch)}?recursive=1`,
        ).catch((error: unknown) => {
          if (
            error instanceof GitHubRequestError &&
            (error.status === 404 || error.status === 409)
          ) {
            return { tree: [], truncated: false };
          }
          throw error;
        })
      : Promise.resolve<GitHubTree>({ tree: [], truncated: false }),
  ]);

  const treeNodes = treeResponse.tree.filter(
    (node) =>
      typeof node?.path === "string" &&
      (node.type === "blob" || node.type === "tree" || node.type === "commit"),
  );
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

  const selectedContentNodes = selectContentNodes(treeNodes, repository.language);
  const retrievedFiles = await Promise.all(
    selectedContentNodes.map(async (node) => {
      if (!node.sha || (typeof node.size === "number" && node.size > 80_000)) {
        return null;
      }
      try {
        const blob = await githubGet<GitHubBlob>(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${node.sha}`,
        );
        if (blob.encoding !== "base64" || typeof blob.content !== "string") {
          return null;
        }
        const text = Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8");
        return { path: node.path, text, contentSummary: summarizeRetrievedFile(node.path, text) };
      } catch (error) {
        if (
          error instanceof GitHubRequestError &&
          (error.status === 404 || error.status === 409)
        ) {
          return null;
        }
        throw error;
      }
    }),
  );
  const successfullyRetrievedFiles = retrievedFiles.filter(
    (file): file is NonNullable<typeof file> => file !== null,
  );
  const retrievedByPath = new Map(
    successfullyRetrievedFiles.map((file) => [file.path, file]),
  );

  const importantNodes = treeNodes
    .filter(isImportantNode)
    .sort((left, right) => {
      const a = contentPathPriority(left);
      const b = contentPathPriority(right);
      return (
        a - b ||
        getPathDepth(left.path) - getPathDepth(right.path) ||
        left.path.localeCompare(right.path)
      );
    })
    .slice(0, 20);
  const importantItems = importantNodes.map((node) => {
    const retrieved = retrievedByPath.get(node.path);
    const type =
      node.type === "tree"
        ? "directory"
        : node.type === "commit"
          ? "submodule"
          : "file";
    return {
      name: basename(node.path),
      path: node.path,
      type,
      htmlUrl: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${type === "file" ? "blob" : "tree"}/${encodeURIComponent(repository.default_branch ?? "")}/${node.path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      importance: getEstimatedPurpose(node.path, type),
      contentRetrieved: Boolean(retrieved),
      contentSummary: retrieved?.contentSummary ?? null,
    };
  });

  const mappedTree = treeNodes.map((node) => {
    const type =
      node.type === "tree"
        ? "directory"
        : node.type === "commit"
          ? "submodule"
          : "file";
    return {
      original: node,
      entry: {
        path: node.path,
        type,
        size: type === "file" && typeof node.size === "number" ? node.size : null,
        depth: Math.max(0, getPathDepth(node.path) - 1),
        estimatedPurpose: getEstimatedPurpose(node.path, type),
      },
    };
  });
  const highValueTreeEntries = mappedTree.sort((left, right) => {
    const leftImportant = isImportantNode(left.original);
    const rightImportant = isImportantNode(right.original);
    if (leftImportant !== rightImportant) return leftImportant ? -1 : 1;
    const leftDepth = getPathDepth(left.entry.path);
    const rightDepth = getPathDepth(right.entry.path);
    if (leftDepth !== rightDepth) return leftDepth - rightDepth;
    if (left.entry.type !== right.entry.type) {
      return left.entry.type === "directory" ? -1 : 1;
    }
    return left.entry.path.localeCompare(right.entry.path);
  });
  const fileTree = highValueTreeEntries.slice(0, 90).map(({ entry }) => entry);
  const retrievedManifests = successfullyRetrievedFiles.filter((file) =>
    contentCandidates
      .slice(1)
      .some((pattern) => pattern.test(basename(file.path))),
  );
  const technologyStack = detectTechnologyStack(languages, retrievedManifests);
  const evidenceSources = [
    "GitHub repository metadata",
    "GitHub language statistics",
    "GitHub recursive file tree",
    ...successfullyRetrievedFiles.map((file) => `${file.path} contents`),
  ];
  const fileTreeEntryCount = treeNodes.length;

  const analysis = AnalyzeRepositoryResponse.parse({
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    description: repository.description,
    htmlUrl: repository.html_url,
    stars: repository.stargazers_count,
    forks: repository.forks_count,
    watchers: repository.subscribers_count,
    defaultBranch: repository.default_branch ?? "Unavailable",
    updatedAt: repository.updated_at,
    license: repository.license?.spdx_id ?? repository.license?.name ?? null,
    primaryLanguage: repository.language ?? languages[0]?.name ?? null,
    languages,
    importantItems,
    fileTree,
    fileTreeEntryCount,
    fileTreeTruncated:
      treeResponse.truncated || fileTreeEntryCount > fileTree.length,
    technologyStack,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    likelyPurposeEstimate: purposeEstimate(repository, successfullyRetrievedFiles),
    evidenceSources,
    overview: createOverview(
      repository,
      languages,
      successfullyRetrievedFiles,
      fileTreeEntryCount,
    ),
  });

  const cacheKey = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  evidenceCache.delete(cacheKey);
  evidenceCache.set(cacheKey, {
    cachedAt: Date.now(),
    analysis,
    treeNodes,
    files: new Map(
      successfullyRetrievedFiles.map((file) => [file.path, file]),
    ),
  });
  while (evidenceCache.size > maxCachedRepositories) {
    const oldestKey = evidenceCache.keys().next().value;
    if (!oldestKey) break;
    evidenceCache.delete(oldestKey);
  }

  return analysis;
}

const nonInformativeQuestionTerms = new Set([
  "about",
  "does",
  "explain",
  "file",
  "files",
  "from",
  "have",
  "help",
  "into",
  "make",
  "more",
  "project",
  "repository",
  "show",
  "tell",
  "that",
  "this",
  "what",
  "where",
  "which",
  "with",
]);

function isTextFilePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    sourceExtensions.test(name) ||
    /^readme(?:\.|$)/i.test(name) ||
    /^requirements(?:[-.]?.*)?\.txt$/i.test(name) ||
    /\.(?:json|md|mdx|rst|toml|ya?ml|xml|ini|conf|sql|txt)$/i.test(name) ||
    /^(?:dockerfile|makefile|license|gemfile)$/i.test(name)
  );
}

function getQuestionTerms(question: string): string[] {
  return [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/)
        .filter(
          (term) =>
            term.length >= 4 && !nonInformativeQuestionTerms.has(term),
        ),
    ),
  ];
}

function findQuestionFileNodes(
  treeNodes: GitHubTreeNode[],
  question: string,
): { nodes: GitHubTreeNode[]; unavailablePaths: string[] } {
  const explicitPaths =
    question.match(
      /(?:[A-Za-z0-9_.@+-]+\/)*[A-Za-z0-9_.@+-]+\.(?:[A-Za-z0-9]{1,8})/g,
    ) ?? [];
  const candidates = treeNodes.filter(
    (node) => node.type === "blob" && node.sha && isTextFilePath(node.path),
  );
  const matched = new Map<string, GitHubTreeNode>();
  const unavailablePaths: string[] = [];

  for (const explicitPath of explicitPaths) {
    const normalizedPath = explicitPath.replace(/^\/+|\/+$/g, "").toLowerCase();
    const matchingNodes = candidates
      .filter(
        (node) =>
          node.path.toLowerCase() === normalizedPath ||
          (!normalizedPath.includes("/") &&
            basename(node.path).toLowerCase() === normalizedPath),
      )
      .sort(
        (left, right) =>
          getPathDepth(left.path) - getPathDepth(right.path) ||
          left.path.localeCompare(right.path),
      );
    if (matchingNodes.length > 0) {
      matched.set(matchingNodes[0].path, matchingNodes[0]);
    } else {
      unavailablePaths.push(explicitPath);
    }
  }

  if (explicitPaths.length === 0) {
    const terms = getQuestionTerms(question);
    const scored = candidates
      .map((node) => ({
        node,
        score: terms.reduce(
          (score, term) =>
            score + (node.path.toLowerCase().includes(term) ? 1 : 0),
          0,
        ),
      }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          getPathDepth(left.node.path) - getPathDepth(right.node.path) ||
          left.node.path.localeCompare(right.node.path),
      );
    for (const { node } of scored.slice(0, 2)) matched.set(node.path, node);
  }

  const matchingNodes = [...matched.values()];
  unavailablePaths.push(...matchingNodes.slice(2).map((node) => node.path));
  return {
    nodes: matchingNodes.slice(0, 2),
    unavailablePaths: [...new Set(unavailablePaths)],
  };
}

function getCachedEvidence(
  owner: string,
  repo: string,
): CachedRepositoryEvidence | undefined {
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const cached = evidenceCache.get(key);
  if (!cached) return undefined;
  if (Date.now() - cached.cachedAt > evidenceCacheTtlMs) {
    evidenceCache.delete(key);
    return undefined;
  }
  evidenceCache.delete(key);
  evidenceCache.set(key, cached);
  return cached;
}

export async function getRepositoryExplanationEvidence(
  owner: string,
  repo: string,
  mode: "overview" | "question",
  question?: string,
): Promise<RepositoryExplanationEvidence> {
  let cached = getCachedEvidence(owner, repo);
  if (!cached) {
    await analyzeGitHubRepository(owner, repo);
    cached = getCachedEvidence(owner, repo);
  }
  if (!cached) throw new Error("Repository evidence could not be prepared.");

  const unavailablePaths: string[] = [];
  if (mode === "question" && question?.trim()) {
    const requested = findQuestionFileNodes(cached.treeNodes, question);
    unavailablePaths.push(...requested.unavailablePaths);
    let newFileFetches = 0;
    for (const node of requested.nodes) {
      if (cached.files.has(node.path)) continue;
      if (
        newFileFetches >= 2 ||
        cached.files.size >= 12 ||
        !node.sha ||
        (typeof node.size === "number" && node.size > maxRetrievedFileBytes)
      ) {
        unavailablePaths.push(node.path);
        continue;
      }
      newFileFetches += 1;
      try {
        const blob = await githubGet<GitHubBlob>(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${node.sha}`,
        );
        if (blob.encoding !== "base64" || typeof blob.content !== "string") {
          unavailablePaths.push(node.path);
          continue;
        }
        const text = Buffer.from(
          blob.content.replace(/\s/g, ""),
          "base64",
        ).toString("utf8");
        cached.files.set(node.path, {
          path: node.path,
          text,
          contentSummary: summarizeRetrievedFile(node.path, text),
        });
      } catch (error) {
        if (
          error instanceof GitHubRequestError &&
          (error.status === 404 || error.status === 409)
        ) {
          unavailablePaths.push(node.path);
          continue;
        }
        throw error;
      }
    }
    cached.cachedAt = Date.now();
  }

  return {
    analysis: cached.analysis,
    files: [...cached.files.values()],
    unavailablePaths: [...new Set(unavailablePaths)],
  };
}
