import { useState, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Activity, AlertCircle, ArrowDownRight, ArrowRight, ArrowUpRight, BookOpen,
  Boxes, Check, Clock3, Code2, ExternalLink, FileCode2, Folder, GitBranch,
  GitFork, Github, Globe2, Info, Scale, Search, Sparkles, Star, Users,
} from 'lucide-react';
import {
  getAnalyzeRepositoryQueryKey,
  getHealthCheckQueryKey,
  useAnalyzeRepository,
  useHealthCheck,
} from '@workspace/api-client-react';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import type { RepositoryAnalysis, RepositoryTreeEntry } from '@workspace/api-client-react';

const queryClient = new QueryClient();
type RepoTarget = { owner: string; repo: string };
type TreeNode = { name: string; path: string; type: 'file' | 'directory' | 'submodule'; purpose: string; size: number | null; children: TreeNode[] };

function parseGitHubUrl(raw: string): RepoTarget | null {
  const input = raw.trim();
  if (!input) return null;
  let candidate = input;
  if (/^github\.com\//i.test(candidate)) candidate = `https://${candidate}`;
  else if (/^[\w.-]+\/[\w.-]+$/.test(candidate)) candidate = `https://github.com/${candidate}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, '');
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner)) return null;
    if (!/^[A-Za-z0-9._-]+$/.test(repo) || repo === '.' || repo === '..') return null;
    return { owner, repo };
  } catch {
    return null;
  }
}

function formatCount(value: number) {
  return new Intl.NumberFormat('en', { notation: value > 9999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getErrorMessage(error: unknown) {
  if (error && typeof error === 'object') {
    if ('error' in error && typeof error.error === 'string') return error.error;
    if ('data' in error && error.data && typeof error.data === 'object' && 'error' in error.data && typeof error.data.error === 'string') return error.data.error;
  }
  if (error instanceof Error && error.message) return error.message;
  return 'We could not analyze this repository right now. Try again in a moment.';
}

function Home() {
  const [input, setInput] = useState('');
  const [submitted, setSubmitted] = useState<RepoTarget | null>(null);
  const [validationError, setValidationError] = useState('');
  const health = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey() } });
  const owner = submitted?.owner ?? '';
  const repo = submitted?.repo ?? '';
  const analysis = useAnalyzeRepository(owner, repo, {
    query: { enabled: Boolean(submitted), queryKey: getAnalyzeRepositoryQueryKey(owner, repo) },
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const target = parseGitHubUrl(input);
    if (!target) {
      setValidationError('Enter a valid public GitHub repository URL, such as github.com/owner/repository.');
      setSubmitted(null);
      return;
    }
    setValidationError('');
    setSubmitted(target);
  }

  const showResults = Boolean(submitted);
  const data = analysis.data as RepositoryAnalysis | undefined;
  const languageColors = ['#58a6ff', '#9a8cff', '#51c6bd', '#75b9ef', '#d1a7ff'];

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="RepoSense AI home">
          <span className="brand-mark"><Boxes aria-hidden="true" /></span>
          <span>RepoSense</span><span className="brand-ai">AI</span>
          <span className="brand-tagline">Understand any codebase, faster.</span>
        </div>
        <div className="top-status" data-testid="status-api">
          <span className={`status-dot ${health.data ? 'online' : health.isError ? 'offline' : ''}`} />
          {health.isLoading ? 'CONNECTING TO API' : health.data ? 'API OPERATIONAL' : health.isError ? 'API UNAVAILABLE' : 'CHECKING API'}
        </div>
      </header>

      <div className="main-wrap">
        <section className="intro-grid">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> REPOSITORY FIELD GUIDE</div>
            <h1 className="hero-title">Get oriented.<br /><em>Build with context.</em></h1>
            <p className="hero-copy">A good map makes unfamiliar code feel navigable. Paste a public GitHub repository and get a clear overview of its structure, stack, and project essentials.</p>
          </div>
          <div className="hero-note"><strong>A clearer first read.</strong>RepoSense brings repository metadata and important files into one approachable view. We mark estimates clearly, so you know what is known and what is inferred.</div>
        </section>

        <form className="search-panel" onSubmit={handleSubmit} noValidate>
          <label htmlFor="repository-url" className="search-label">Public repository URL</label>
          <div className="search-row">
            <div className="search-input-wrap">
              <Github size={18} aria-hidden="true" />
              <input id="repository-url" className="repo-input" value={input} onChange={(event) => { setInput(event.target.value); if (validationError) setValidationError(''); }} placeholder="https://github.com/owner/repository" autoComplete="url" aria-invalid={Boolean(validationError)} aria-describedby={validationError ? 'url-error' : 'url-hint'} data-testid="input-repository-url" />
            </div>
            <button className="analyze-btn" type="submit" disabled={analysis.isFetching} data-testid="button-analyze">
              {analysis.isFetching ? <>Reading repository <Activity size={15} /></> : <>Analyze Repository <ArrowRight size={16} /></>}
            </button>
          </div>
          {validationError ? <p className="form-error" id="url-error" role="alert" data-testid="error-invalid-url">{validationError}</p> : <div className="search-hint" id="url-hint">Public repositories only. A repository URL or owner/name both work.</div>}
        </form>

        <section className="workbench" aria-live="polite">
          <div className="section-kicker">{showResults ? 'REPOSITORY MAP' : 'YOUR WORKSPACE'}</div>
          {!showResults && <div className="empty-panel" data-testid="empty-repository-state">
            <div><div className="empty-symbol"><Search size={20} aria-hidden="true" /></div><h2 className="empty-title">Start with a repository</h2><p className="empty-copy">Enter a GitHub URL above. We’ll gather public project details and root-level guideposts.</p></div>
          </div>}
          {showResults && analysis.isFetching && <div className="loading-card" data-testid="loading-analysis">
            <div className="skeleton loading-line short" /><div className="skeleton loading-line med" />
            <div className="skeleton loading-line" style={{ height: 74, marginTop: 24 }} /><div className="skeleton loading-line" style={{ height: 126, marginTop: 18 }} />
            <p className="search-hint">Fetching repository metadata, language statistics, the project tree, and selected file contents…</p>
          </div>}
          {showResults && analysis.isError && !analysis.isFetching && <div className="error-panel" role="alert" data-testid="error-analysis">
            <AlertCircle className="error-icon" size={25} /><div><h2 className="empty-title">This repository could not be mapped</h2><p className="empty-copy">{getErrorMessage(analysis.error)}</p><button className="retry-btn" type="button" onClick={() => analysis.refetch()} data-testid="button-retry">Try again</button></div>
          </div>}
          {data && !analysis.isFetching && !analysis.isError && <RepositoryResults data={data} languageColors={languageColors} />}
        </section>

        <footer className="footer"><span>REPOSENSE AI <span className="footer-separator">·</span> A MAP, NOT A BLACK BOX</span><span>Repository metadata provided by the RepoSense API</span></footer>
      </div>
    </main>
  );
}

function RepositoryResults({ data, languageColors }: { data: RepositoryAnalysis; languageColors: string[] }) {
  return (
    <article data-testid="repository-analysis">
      <div className="results-head">
        <div className="repo-heading"><div className="repo-glyph"><Github size={20} /></div><div>
          <div className="repo-owner">{data.owner} /</div><h2 className="repo-name">{data.name}</h2>
          <p className="repo-desc">{data.description || 'No repository description has been provided.'}</p>
        </div></div>
        <a className="external-link" href={data.htmlUrl} target="_blank" rel="noreferrer" data-testid="link-open-github">View on GitHub <ExternalLink size={13} /></a>
      </div>
      <div className="stats-row">
        <Stat icon={<Star size={14} />} label="Stars" value={formatCount(data.stars)} />
        <Stat icon={<GitFork size={14} />} label="Forks" value={formatCount(data.forks)} />
        <Stat icon={<Users size={14} />} label="Watchers" value={formatCount(data.watchers)} />
        <Stat icon={<Code2 size={14} />} label="Main language" value={data.primaryLanguage || 'Not detected'} />
      </div>

      <div className="results-body">
        <div className="metadata-row">
          <span className="meta-chip"><GitBranch size={13} /> Default branch: {data.defaultBranch}</span>
          <span className="meta-chip"><Clock3 size={13} /> Updated {formatDate(data.updatedAt)}</span>
          <span className="meta-chip"><Scale size={13} /> {data.license || 'No license specified'}</span>
          <span className="meta-chip"><Globe2 size={13} /> {data.fullName}</span>
        </div>

        <section className="overview-section">
          <div className="section-heading"><div><span className="section-index">01</span><h3>Repository overview</h3></div><span className="fact-label"><Check size={12} /> FACTS FROM FETCHED GITHUB DATA</span></div>
          <p className="overview-copy">{data.overview}</p>
          <div className="fact-grid">
            <Fact label="Repository" value={data.fullName} />
            <Fact label="Default branch" value={data.defaultBranch} />
            <Fact label="Last updated" value={formatDate(data.updatedAt)} />
            <Fact label="License" value={data.license || 'Not specified'} />
            <Fact label="Primary language" value={data.primaryLanguage || 'Not detected'} />
            <Fact label="Community" value={`${formatCount(data.stars)} stars · ${formatCount(data.forks)} forks`} />
          </div>
        </section>

        <div className="content-grid">
          <section className="info-card purpose-card">
            <h3 className="card-title"><BookOpen size={15} /> Likely project purpose <span className="estimate-badge"><Info size={11} /> ESTIMATE</span></h3>
            <p className="purpose-copy">{data.likelyPurposeEstimate || 'A purpose estimate is not available for this repository.'}</p>
            {data.evidenceSources.length > 0 && <div className="evidence-block"><span className="micro-label">BASIS FOR THIS ESTIMATE</span><ul>{data.evidenceSources.map((source, index) => <li key={`${source}-${index}`}>{source}</li>)}</ul></div>}
          </section>
          <section className="info-card">
            <h3 className="card-title"><Code2 size={15} /> Detected technology stack</h3>
            <p className="section-description">Languages come from GitHub statistics. Framework names are shown only when found in a fetched project manifest.</p>
            {data.technologyStack.length > 0 ? <div className="stack-list">{data.technologyStack.map((technology, index) => <span className="stack-chip" key={`${technology}-${index}`} data-testid={`technology-${index}`}><span className="stack-dot" />{technology}</span>)}</div> : <p className="overview-copy">No technology stack details were detected.</p>}
            <div className="language-subsection">
              <div className="subheading">Language breakdown</div>
              {data.languages.length > 0 ? <div className="language-list">{data.languages.map((language, index) => <div className="language-item" key={language.name} data-testid={`language-${index}`}>
                <div className="language-top"><strong>{language.name}</strong><span>{language.percentage.toFixed(1)}% · {formatBytes(language.bytes)}</span></div>
                <div className="language-track"><div className="language-fill" style={{ width: `${Math.min(100, Math.max(0, language.percentage))}%`, backgroundColor: languageColors[index % languageColors.length] }} /></div>
              </div>)}</div> : <p className="muted-small">Language statistics are not available.</p>}
            </div>
          </section>
        </div>

        <section className="info-card important-card">
          <div className="card-heading-row"><div><h3 className="card-title"><Folder size={15} /> Important files &amp; folders <span className="item-count">{data.importantItems.length} items</span></h3><p className="section-description">A quick guide to notable repository entry points. Roles are estimates based on each item’s name and path.</p></div><span className="estimate-badge"><Info size={11} /> PURPOSE ESTIMATES</span></div>
          {data.importantItems.length > 0 ? <div className="file-list">{data.importantItems.map((item, index) => {
            const hasSummary = item.contentRetrieved && Boolean(item.contentSummary);
            return <div className="file-row" key={`${item.path}-${index}`} data-testid={`row-important-item-${index}`}>
              <a className="file-main" href={item.htmlUrl} target="_blank" rel="noreferrer" data-testid={`link-important-item-${index}`}>
                <span className="file-icon">{item.type === 'directory' ? <Folder size={14} /> : <FileCode2 size={14} />}</span>
                <span className="file-name">{item.path}</span><ArrowUpRight className="file-arrow" size={14} />
              </a>
              <div className="file-details"><span className="file-purpose">{item.importance}</span>
                {item.contentRetrieved ? <span className="retrieval-status retrieved"><Check size={11} /> Content retrieved</span> : <span className="retrieval-status"><Info size={11} /> Name/path estimate only</span>}
                {hasSummary && <p className="content-summary">{item.contentSummary}</p>}
              </div>
            </div>;
          })}</div> : <p className="overview-copy">No important files or folders were returned.</p>}
          <p className="content-note"><Info size={13} /> Content summaries appear only for files whose contents were actually retrieved.</p>
        </section>

        <ProjectTree entries={data.fileTree} entryCount={data.fileTreeEntryCount} truncated={data.fileTreeTruncated} />

        <aside className="future-panel" aria-label="Future features">
          <Sparkles className="future-icon" size={17} /><div><div className="future-title">Coming later · not available yet</div><p className="future-copy">AI chat for repository questions and automated code-quality analysis are planned future features. Neither is available in this version.</p></div><ArrowDownRight size={15} className="future-arrow" />
        </aside>
      </div>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="fact"><span>{label}</span><strong>{value}</strong></div>;
}

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return <div className="stat"><div className="stat-label">{icon}{label}</div><div className="stat-value">{value}</div></div>;
}

function makeTree(entries: RepositoryTreeEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const lookup = new Map<string, TreeNode>();
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of sorted) {
    const parts = entry.path.split('/').filter(Boolean);
    let parentPath = '';
    let parentChildren = roots;
    parts.forEach((part, index) => {
      const path = parentPath ? `${parentPath}/${part}` : part;
      const isLast = index === parts.length - 1;
      let node = lookup.get(path);
      if (!node) {
        node = { name: part, path, type: isLast ? entry.type : 'directory', purpose: isLast ? entry.estimatedPurpose : 'Folder in the project structure', size: isLast ? entry.size : null, children: [] };
        lookup.set(path, node);
        parentChildren.push(node);
      } else if (isLast) {
        node.type = entry.type;
        node.purpose = entry.estimatedPurpose;
        node.size = entry.size;
      }
      parentPath = path;
      parentChildren = node.children;
    });
  }
  return roots;
}

function ProjectTree({ entries, entryCount, truncated }: { entries: RepositoryTreeEntry[]; entryCount: number; truncated: boolean }) {
  const nodes = makeTree(entries);
  return <section className="info-card tree-card">
    <div className="card-heading-row"><div><h3 className="card-title"><Boxes size={15} /> Project structure <span className="item-count">{entryCount} entries</span></h3><p className="section-description">A compact view of paths in this repository. Folder roles are estimates from names and paths.</p></div><span className="estimate-badge"><Info size={11} /> PATH-BASED ESTIMATES</span></div>
    {truncated && <div className="tree-preview-notice" role="note"><Info size={14} /> This display is a selected preview of a larger project tree.</div>}
    {nodes.length > 0 ? <div className="tree-view" data-testid="project-structure">{nodes.map((node) => <TreeBranch node={node} depth={0} key={node.path} />)}</div> : <p className="overview-copy">No project-structure entries were returned.</p>}
  </section>;
}

function TreeBranch({ node, depth }: { node: TreeNode; depth: number }) {
  return <div className="tree-branch">
    <div className="tree-row" style={{ paddingLeft: `${depth * 17 + 10}px` }} data-testid={`tree-entry-${node.path.replace(/[^a-zA-Z0-9_-]/g, '-')}`}>
      <span className={`tree-type-icon ${node.type}`}>{node.type === 'directory' ? <Folder size={13} /> : node.type === 'submodule' ? <GitBranch size={13} /> : <FileCode2 size={13} />}</span>
      <span className="tree-name">{node.name}</span><span className="tree-purpose">{node.purpose}</span>
      {node.size !== null && <span className="tree-size">{formatBytes(node.size)}</span>}
    </div>
    {node.children.map((child) => <TreeBranch node={child} depth={depth + 1} key={child.path} />)}
  </div>;
}

function Router() {
  return <RoutedErrorBoundary><Switch><Route path="/" component={Home} /><Route component={NotFound} /></Switch></RoutedErrorBoundary>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
