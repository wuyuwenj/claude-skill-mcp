/**
 * Type definitions for Skill Seekers MCP Server
 */

// Job status enum
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed';

// Job types
export type JobType = 'scrape_docs' | 'scrape_github' | 'scrape_pdf';

// Job interface for tracking async operations
export interface Job {
    id: string;
    type: JobType;
    status: JobStatus;
    progress: number; // 0-100
    message: string;
    config: SkillConfig;
    result?: JobResult;
    error?: string;
    createdAt: Date;
    updatedAt: Date;
    completedAt?: Date;
}

// Job result after completion
export interface JobResult {
    skillId: string;
    skillName: string;
    pagesScraped: number;
    filesGenerated: string[];
    downloadUrl?: string;
}

// Skill configuration
export interface SkillConfig {
    name: string;
    description: string;
    // Documentation source
    baseUrl?: string;
    startUrls?: string[];
    maxPages?: number;
    rateLimit?: number;
    selectors?: ContentSelectors;
    urlPatterns?: UrlPatterns;
    categories?: Record<string, CategoryConfig>;
    // GitHub source
    repo?: string;
    githubToken?: string;
    includeIssues?: boolean;
    includeReleases?: boolean;
    includeChangelog?: boolean;
    maxIssues?: number;
    codeAnalysisDepth?: 'surface' | 'deep';
    // PDF source
    pdfPath?: string;
    pdfUrl?: string;
}

// Content selectors for scraping
export interface ContentSelectors {
    mainContent?: string;
    title?: string;
    codeBlocks?: string;
    navigation?: string;
    exclude?: string[];
}

// URL patterns for crawling
export interface UrlPatterns {
    include?: string[];
    exclude?: string[];
}

// Category configuration
export interface CategoryConfig {
    patterns?: string[];
    priority?: number;
    description?: string;
}

// Scraped documentation page
export interface DocPage {
    id: string;
    source: string;
    title: string;
    content: string;
    snippet: string;
    type: 'api' | 'guide' | 'example';
    url: string;
    searchableText: string;
    category?: string;
    apiReference?: ApiReference;
    codeExamples?: string[];
}

// API reference extracted from docs
export interface ApiReference {
    signature?: string;
    parameters?: string[];
    returns?: string;
    example?: string;
    deprecated?: boolean;
}

// GitHub repository data
export interface GitHubRepoData {
    name: string;
    fullName: string;
    description: string;
    stars: number;
    forks: number;
    language: string;
    languages: Record<string, number>;
    readme: string;
    fileTree: FileTreeNode[];
    issues: GitHubIssue[];
    releases: GitHubRelease[];
    changelog?: string;
}

// File tree node
export interface FileTreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
    children?: FileTreeNode[];
}

// GitHub issue
export interface GitHubIssue {
    number: number;
    title: string;
    body: string;
    state: 'open' | 'closed';
    labels: string[];
    createdAt: string;
    updatedAt: string;
}

// GitHub release
export interface GitHubRelease {
    tagName: string;
    name: string;
    body: string;
    publishedAt: string;
    prerelease: boolean;
}

// PDF extracted data
export interface PdfData {
    title: string;
    content: string;
    pages: number;
    metadata?: Record<string, string>;
    sections: PdfSection[];
}

// PDF section
export interface PdfSection {
    title: string;
    content: string;
    pageNumber: number;
    codeBlocks?: string[];
}

// Generated skill package
export interface SkillPackage {
    id: string;
    name: string;
    description: string;
    files: SkillFile[];
    createdAt: Date;
    source: {
        type: JobType;
        url?: string;
        repo?: string;
        pdfPath?: string;
    };
    stats: {
        totalPages: number;
        categories: number;
        codeExamples: number;
    };
}

// File in skill package
export interface SkillFile {
    path: string;
    content: string;
    size: number;
}

// Actor input configuration
export interface ActorInput {
    githubToken?: string;
    anthropicApiKey?: string;
    maxConcurrentJobs?: number;
    defaultMaxPages?: number;
}

// Preset config (from configs/ directory)
export interface PresetConfig {
    name: string;
    description: string;
    baseUrl: string;
    type: 'documentation' | 'github' | 'pdf';
    config: SkillConfig;
}
