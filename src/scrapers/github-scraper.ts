/**
 * GitHub Repository Scraper
 * Extracts README, issues, releases, and file structure from GitHub repos
 */

import { Octokit } from '@octokit/rest';
import { log } from 'apify';
import { Job, JobResult, GitHubRepoData, GitHubIssue, GitHubRelease, FileTreeNode, DocPage, CodeBlock } from '../types.js';
import { buildSkill } from '../skill-builder.js';

/**
 * Scrape a GitHub repository
 */
export async function scrapeGitHub(
    job: Job,
    updateProgress: (progress: number, message: string) => Promise<void>
): Promise<JobResult> {
    const config = job.config;

    if (!config.repo) {
        throw new Error('GitHub repository not specified');
    }

    const [owner, repo] = config.repo.split('/');
    if (!owner || !repo) {
        throw new Error('Invalid repository format. Use owner/repo');
    }

    await updateProgress(5, `Connecting to GitHub: ${config.repo}...`);

    // Initialize Octokit
    const octokit = new Octokit({
        auth: config.githubToken,
    });

    const repoData: GitHubRepoData = {
        name: repo,
        fullName: config.repo,
        description: '',
        stars: 0,
        forks: 0,
        language: '',
        languages: {},
        readme: '',
        fileTree: [],
        issues: [],
        releases: [],
    };

    // Fetch repository info
    await updateProgress(10, 'Fetching repository info...');
    try {
        const { data: repoInfo } = await octokit.repos.get({ owner, repo });
        repoData.description = repoInfo.description ?? '';
        repoData.stars = repoInfo.stargazers_count;
        repoData.forks = repoInfo.forks_count;
        repoData.language = repoInfo.language ?? '';
    } catch (error) {
        log.warning(`Failed to fetch repo info: ${error}`);
    }

    // Fetch languages
    await updateProgress(15, 'Fetching language statistics...');
    try {
        const { data: languages } = await octokit.repos.listLanguages({ owner, repo });
        repoData.languages = languages;
    } catch (error) {
        log.warning(`Failed to fetch languages: ${error}`);
    }

    // Fetch README
    await updateProgress(20, 'Fetching README...');
    try {
        const { data: readme } = await octokit.repos.getReadme({
            owner,
            repo,
            mediaType: { format: 'raw' },
        });
        repoData.readme = typeof readme === 'string' ? readme : '';
    } catch (error) {
        log.warning(`Failed to fetch README: ${error}`);
    }

    // Fetch file tree
    await updateProgress(30, 'Fetching file structure...');
    try {
        const { data: tree } = await octokit.git.getTree({
            owner,
            repo,
            tree_sha: 'HEAD',
            recursive: 'true',
        });

        repoData.fileTree = buildFileTree(tree.tree);
    } catch (error) {
        log.warning(`Failed to fetch file tree: ${error}`);
    }

    // Fetch issues if enabled
    if (config.includeIssues !== false) {
        await updateProgress(45, 'Fetching issues...');
        const maxIssues = config.maxIssues ?? 100;

        try {
            const { data: issues } = await octokit.issues.listForRepo({
                owner,
                repo,
                state: 'all',
                per_page: Math.min(maxIssues, 100),
                sort: 'updated',
                direction: 'desc',
            });

            repoData.issues = issues
                .filter((issue) => !issue.pull_request) // Exclude PRs
                .slice(0, maxIssues)
                .map((issue) => ({
                    number: issue.number,
                    title: issue.title,
                    body: issue.body ?? '',
                    state: issue.state as 'open' | 'closed',
                    labels: issue.labels
                        .map((l) => (typeof l === 'string' ? l : l.name ?? ''))
                        .filter(Boolean),
                    createdAt: issue.created_at,
                    updatedAt: issue.updated_at,
                }));
        } catch (error) {
            log.warning(`Failed to fetch issues: ${error}`);
        }
    }

    // Fetch releases if enabled
    if (config.includeReleases !== false) {
        await updateProgress(60, 'Fetching releases...');
        try {
            const { data: releases } = await octokit.repos.listReleases({
                owner,
                repo,
                per_page: 20,
            });

            repoData.releases = releases.map((release) => ({
                tagName: release.tag_name,
                name: release.name ?? release.tag_name,
                body: release.body ?? '',
                publishedAt: release.published_at ?? '',
                prerelease: release.prerelease,
            }));
        } catch (error) {
            log.warning(`Failed to fetch releases: ${error}`);
        }
    }

    // Fetch CHANGELOG if enabled
    if (config.includeChangelog !== false) {
        await updateProgress(70, 'Fetching CHANGELOG...');
        for (const filename of ['CHANGELOG.md', 'CHANGELOG', 'HISTORY.md', 'CHANGES.md']) {
            try {
                const { data: content } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: filename,
                    mediaType: { format: 'raw' },
                });
                if (typeof content === 'string') {
                    repoData.changelog = content;
                    break;
                }
            } catch {
                // File not found, try next
            }
        }
    }

    await updateProgress(80, 'Building documentation pages...');

    // Convert GitHub data to doc pages
    const docs = convertToDocPages(repoData, config.name);

    await updateProgress(90, 'Building skill package...');

    // Build skill
    const skillResult = await buildSkill(
        config.name ?? repo,
        config.description ?? repoData.description,
        docs,
        'scrape_github',
        `https://github.com/${config.repo}`
    );

    await updateProgress(100, `Skill built from GitHub repo with ${docs.length} pages`);

    return {
        skillId: skillResult.id,
        skillName: skillResult.name,
        pagesScraped: docs.length,
        filesGenerated: skillResult.files.map((f) => f.path),
        downloadUrl: skillResult.downloadUrl,
    };
}

/**
 * Build file tree from GitHub API response
 */
function buildFileTree(
    items: { path?: string; type?: string; size?: number }[]
): FileTreeNode[] {
    const root: FileTreeNode[] = [];
    const nodeMap: Map<string, FileTreeNode> = new Map();

    // Sort by path to ensure parents are processed first
    const sortedItems = items
        .filter((item) => item.path)
        .sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''));

    for (const item of sortedItems) {
        const path = item.path ?? '';
        const parts = path.split('/');
        const name = parts[parts.length - 1];
        const parentPath = parts.slice(0, -1).join('/');

        const node: FileTreeNode = {
            name,
            path,
            type: item.type === 'tree' ? 'directory' : 'file',
            size: item.size,
        };

        if (node.type === 'directory') {
            node.children = [];
        }

        nodeMap.set(path, node);

        if (parentPath === '') {
            root.push(node);
        } else {
            const parent = nodeMap.get(parentPath);
            if (parent && parent.children) {
                parent.children.push(node);
            }
        }
    }

    return root;
}

/**
 * Convert GitHub repo data to documentation pages
 */
function convertToDocPages(repoData: GitHubRepoData, skillName: string): DocPage[] {
    const docs: DocPage[] = [];

    // README as main page
    if (repoData.readme) {
        const { codeExamples, codeBlocks } = extractCodeBlocksFromMarkdown(repoData.readme);
        docs.push({
            id: 'docs-1',
            source: skillName,
            title: `${repoData.name} - README`,
            content: repoData.readme,
            snippet: repoData.readme.substring(0, 200) + '...',
            type: codeExamples.length > 0 ? 'example' : 'guide',
            url: `https://github.com/${repoData.fullName}`,
            searchableText: `${repoData.name} readme ${repoData.readme}`.toLowerCase(),
            category: 'overview',
            codeExamples,
            codeBlocks,
        });
    }

    // Repository overview
    docs.push({
        id: `docs-${docs.length + 1}`,
        source: skillName,
        title: `${repoData.name} - Repository Overview`,
        content: formatRepoOverview(repoData),
        snippet: repoData.description || 'Repository overview',
        type: 'guide',
        url: `https://github.com/${repoData.fullName}`,
        searchableText: `${repoData.name} overview ${repoData.description}`.toLowerCase(),
        category: 'overview',
    });

    // File structure
    if (repoData.fileTree.length > 0) {
        docs.push({
            id: `docs-${docs.length + 1}`,
            source: skillName,
            title: `${repoData.name} - File Structure`,
            content: formatFileTree(repoData.fileTree),
            snippet: 'Repository file structure and organization',
            type: 'guide',
            url: `https://github.com/${repoData.fullName}`,
            searchableText: `${repoData.name} files structure tree`.toLowerCase(),
            category: 'structure',
        });
    }

    // Issues (grouped)
    if (repoData.issues.length > 0) {
        // Open issues
        const openIssues = repoData.issues.filter((i) => i.state === 'open');
        if (openIssues.length > 0) {
            const openContent = openIssues.map(i => i.body).join('\n\n');
            const { codeExamples, codeBlocks } = extractCodeBlocksFromMarkdown(openContent);
            docs.push({
                id: `docs-${docs.length + 1}`,
                source: skillName,
                title: `${repoData.name} - Open Issues`,
                content: formatIssues(openIssues),
                snippet: `${openIssues.length} open issues`,
                type: codeExamples.length > 0 ? 'example' : 'guide',
                url: `https://github.com/${repoData.fullName}/issues`,
                searchableText: openIssues.map((i) => i.title).join(' ').toLowerCase(),
                category: 'issues',
                codeExamples,
                codeBlocks,
            });
        }

        // Recent closed issues (for context)
        const closedIssues = repoData.issues.filter((i) => i.state === 'closed').slice(0, 20);
        if (closedIssues.length > 0) {
            const closedContent = closedIssues.map(i => i.body).join('\n\n');
            const { codeExamples, codeBlocks } = extractCodeBlocksFromMarkdown(closedContent);
            docs.push({
                id: `docs-${docs.length + 1}`,
                source: skillName,
                title: `${repoData.name} - Recently Closed Issues`,
                content: formatIssues(closedIssues),
                snippet: `${closedIssues.length} recently closed issues`,
                type: codeExamples.length > 0 ? 'example' : 'guide',
                url: `https://github.com/${repoData.fullName}/issues?q=is%3Aclosed`,
                searchableText: closedIssues.map((i) => i.title).join(' ').toLowerCase(),
                category: 'issues',
                codeExamples,
                codeBlocks,
            });
        }
    }

    // Releases
    if (repoData.releases.length > 0) {
        const releaseContent = repoData.releases.map(r => r.body).join('\n\n');
        const { codeExamples, codeBlocks } = extractCodeBlocksFromMarkdown(releaseContent);
        docs.push({
            id: `docs-${docs.length + 1}`,
            source: skillName,
            title: `${repoData.name} - Releases`,
            content: formatReleases(repoData.releases),
            snippet: `${repoData.releases.length} releases`,
            type: codeExamples.length > 0 ? 'example' : 'guide',
            url: `https://github.com/${repoData.fullName}/releases`,
            searchableText: repoData.releases.map((r) => `${r.name} ${r.body}`).join(' ').toLowerCase(),
            category: 'releases',
            codeExamples,
            codeBlocks,
        });
    }

    // Changelog
    if (repoData.changelog) {
        const { codeExamples, codeBlocks } = extractCodeBlocksFromMarkdown(repoData.changelog);
        docs.push({
            id: `docs-${docs.length + 1}`,
            source: skillName,
            title: `${repoData.name} - Changelog`,
            content: repoData.changelog,
            snippet: 'Project changelog and version history',
            type: codeExamples.length > 0 ? 'example' : 'guide',
            url: `https://github.com/${repoData.fullName}/blob/main/CHANGELOG.md`,
            searchableText: `${repoData.name} changelog history ${repoData.changelog}`.toLowerCase(),
            category: 'releases',
            codeExamples,
            codeBlocks,
        });
    }

    return docs;
}

/**
 * Format repository overview
 */
function formatRepoOverview(repoData: GitHubRepoData): string {
    const lines: string[] = [
        `# ${repoData.name}`,
        '',
        repoData.description || '',
        '',
        '## Statistics',
        `- **Stars:** ${repoData.stars}`,
        `- **Forks:** ${repoData.forks}`,
        `- **Primary Language:** ${repoData.language}`,
        '',
        '## Languages',
    ];

    const totalBytes = Object.values(repoData.languages).reduce((a, b) => a + b, 0);
    for (const [lang, bytes] of Object.entries(repoData.languages)) {
        const percentage = ((bytes / totalBytes) * 100).toFixed(1);
        lines.push(`- ${lang}: ${percentage}%`);
    }

    return lines.join('\n');
}

/**
 * Format file tree
 */
function formatFileTree(nodes: FileTreeNode[], indent = 0): string {
    const lines: string[] = [];

    if (indent === 0) {
        lines.push('# File Structure', '');
    }

    for (const node of nodes.slice(0, 100)) {
        // Limit to prevent huge output
        const prefix = '  '.repeat(indent);
        const icon = node.type === 'directory' ? '📁' : '📄';
        lines.push(`${prefix}${icon} ${node.name}`);

        if (node.children && indent < 3) {
            // Limit depth
            lines.push(formatFileTree(node.children, indent + 1));
        }
    }

    return lines.join('\n');
}

/**
 * Format issues list
 */
function formatIssues(issues: GitHubIssue[]): string {
    const lines: string[] = ['# Issues', ''];

    for (const issue of issues) {
        lines.push(`## #${issue.number}: ${issue.title}`);
        lines.push(`**State:** ${issue.state} | **Labels:** ${issue.labels.join(', ') || 'none'}`);
        lines.push(`**Created:** ${issue.createdAt} | **Updated:** ${issue.updatedAt}`);
        lines.push('');
        if (issue.body) {
            lines.push(issue.body.substring(0, 500) + (issue.body.length > 500 ? '...' : ''));
        }
        lines.push('');
        lines.push('---');
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Format releases list
 */
function formatReleases(releases: GitHubRelease[]): string {
    const lines: string[] = ['# Releases', ''];

    for (const release of releases) {
        const tag = release.prerelease ? `${release.tagName} (pre-release)` : release.tagName;
        lines.push(`## ${release.name || tag}`);
        lines.push(`**Tag:** ${release.tagName} | **Published:** ${release.publishedAt}`);
        lines.push('');
        if (release.body) {
            lines.push(release.body);
        }
        lines.push('');
        lines.push('---');
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Extract code blocks from markdown content
 */
function extractCodeBlocksFromMarkdown(content: string): { codeExamples: string[]; codeBlocks: CodeBlock[] } {
    const codeExamples: string[] = [];
    const codeBlocks: CodeBlock[] = [];

    // Match fenced code blocks: ```language\ncode\n```
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
        const language = match[1] || undefined;
        const code = match[2].trim();

        if (code.length < 10) continue;

        codeExamples.push(code);

        // Detect if complete script
        const isScript = isCompleteScript(code, language);

        // Detect if template
        const isTemplate = isTemplateCode(code);

        // Generate filename
        const filename = generateFilename(code, language);

        // Find title from context (line before code block)
        const beforeBlock = content.substring(0, match.index);
        const lines = beforeBlock.split('\n');
        let title: string | undefined;
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
            const line = lines[i].trim();
            if (line.startsWith('#')) {
                title = line.replace(/^#+\s*/, '');
                break;
            }
        }

        codeBlocks.push({
            code,
            language: normalizeLanguage(language),
            filename,
            isScript,
            isTemplate,
            title,
        });
    }

    return { codeExamples, codeBlocks };
}

/**
 * Normalize language name
 */
function normalizeLanguage(lang?: string): string | undefined {
    if (!lang) return undefined;

    const langMap: Record<string, string> = {
        'py': 'python',
        'js': 'javascript',
        'ts': 'typescript',
        'sh': 'bash',
        'shell': 'bash',
        'zsh': 'bash',
        'yml': 'yaml',
        'dockerfile': 'docker',
    };

    return langMap[lang.toLowerCase()] || lang.toLowerCase();
}

/**
 * Generate filename based on code content and language
 */
function generateFilename(code: string, language?: string): string | undefined {
    // Check for shebang
    if (code.startsWith('#!/')) {
        if (code.includes('/python')) return 'script.py';
        if (code.includes('/bash') || code.includes('/sh')) return 'script.sh';
        if (code.includes('/node')) return 'script.js';
    }

    if (!language) return undefined;

    const extMap: Record<string, string> = {
        'python': '.py',
        'py': '.py',
        'javascript': '.js',
        'js': '.js',
        'typescript': '.ts',
        'ts': '.ts',
        'bash': '.sh',
        'sh': '.sh',
        'shell': '.sh',
        'ruby': '.rb',
        'go': '.go',
        'rust': '.rs',
        'java': '.java',
        'yaml': '.yaml',
        'yml': '.yaml',
        'json': '.json',
        'dockerfile': 'Dockerfile',
    };

    const ext = extMap[language.toLowerCase()];
    return ext ? `script${ext}` : undefined;
}

/**
 * Determine if code is a complete runnable script
 */
function isCompleteScript(code: string, language?: string): boolean {
    // Has shebang
    if (code.startsWith('#!/')) return true;

    const lang = language?.toLowerCase();

    // Python: has if __name__ == "__main__" or complete function definitions
    if (lang === 'python' || lang === 'py') {
        if (code.includes('if __name__')) return true;
        if (code.includes('def main(')) return true;
        const defCount = (code.match(/^def \w+\(/gm) || []).length;
        if (defCount >= 2) return true;
    }

    // Bash: has multiple commands or function definitions
    if (lang === 'bash' || lang === 'sh' || lang === 'shell') {
        const lines = code.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
        if (lines.length >= 5) return true;
    }

    // JavaScript/TypeScript: has exports or is a complete module
    if (lang === 'javascript' || lang === 'js' || lang === 'typescript' || lang === 'ts') {
        if (code.includes('export ') || code.includes('module.exports')) return true;
        if (code.includes('async function') && code.length > 200) return true;
    }

    // Code is long enough to be a complete script
    if (code.split('\n').length >= 20) return true;

    return false;
}

/**
 * Detect if code contains template placeholders
 */
function isTemplateCode(code: string): boolean {
    // Mustache/Handlebars style: {{variable}}
    if (/\{\{[^}]+\}\}/.test(code)) return true;

    // Jinja/Django style: {% %}
    if (/\{%[^%]+%\}/.test(code)) return true;

    // Placeholder patterns: <YOUR_VALUE>, [YOUR_VALUE], YOUR_API_KEY, etc.
    if (/<[A-Z_]+>/.test(code)) return true;
    if (/\[[A-Z_]+\]/.test(code)) return true;
    if (/YOUR_[A-Z_]+/.test(code)) return true;
    if (/\$\{[^}]+\}/.test(code)) return true;

    // Config file patterns with placeholders
    if (/: <[^>]+>/.test(code)) return true;
    if (/= "<[^>]+"/.test(code)) return true;

    return false;
}
