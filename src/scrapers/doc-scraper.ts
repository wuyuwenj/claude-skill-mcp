/**
 * Documentation Scraper
 * Scrapes documentation websites and extracts structured content
 */

import { CheerioCrawler, RequestQueue } from 'crawlee';
import { log } from 'apify';
import { DocPage, SkillConfig, Job, JobResult } from '../types.js';
import { buildSkill } from '../skill-builder.js';

// Use any for cheerio types to avoid conflicts between crawlee's cheerio and standalone cheerio
/* eslint-disable @typescript-eslint/no-explicit-any */
type CheerioAPI = any;

/**
 * Scrape documentation from a website
 */
export async function scrapeDocumentation(
    job: Job,
    updateProgress: (progress: number, message: string) => Promise<void>
): Promise<JobResult> {
    const config = job.config;
    const docs: DocPage[] = [];

    // Determine start URLs
    const startUrls = config.startUrls ?? (config.baseUrl ? [config.baseUrl] : []);
    if (startUrls.length === 0) {
        throw new Error('No start URLs provided');
    }

    const maxPages = config.maxPages ?? 100;
    let pagesScraped = 0;

    await updateProgress(5, `Starting scrape of ${startUrls.length} URL(s)...`);

    // Generate URL patterns for crawling
    const urlPatterns = generateUrlPatterns(startUrls, config.urlPatterns);
    log.info('URL patterns:', { urlPatterns });

    // Create request queue
    const requestQueue = await RequestQueue.open();

    // Add start URLs
    for (const url of startUrls) {
        await requestQueue.addRequest({ url });
    }

    // Create crawler
    const crawler = new CheerioCrawler({
        requestQueue,
        maxRequestsPerCrawl: maxPages,
        maxConcurrency: 5,
        requestHandlerTimeoutSecs: 30,

        async requestHandler({ request, $, enqueueLinks }) {
            pagesScraped++;
            const progress = Math.min(90, Math.floor((pagesScraped / maxPages) * 85) + 5);
            await updateProgress(progress, `Scraped ${pagesScraped}/${maxPages} pages: ${request.url}`);

            log.info(`Scraping: ${request.url}`);

            // Extract page data with configurable selectors
            const selectors = config.selectors ?? {};
            const title = extractTitle($, selectors.title);
            const content = extractContent($, selectors.mainContent, selectors.exclude);
            const codeExamples = extractCodeBlocks($, selectors.codeBlocks);

            // Skip empty pages
            if (!title || content.length < 50) {
                log.warning(`Skipping page with insufficient content: ${request.url}`);
                return;
            }

            // Determine page type
            const type = determinePageType(request.url, content);

            // Determine category
            const category = determineCategory(request.url, config.categories);

            // Create doc page
            const docPage: DocPage = {
                id: `docs-${docs.length + 1}`,
                source: config.name,
                title,
                content,
                snippet: content.substring(0, 200) + '...',
                type,
                url: request.url,
                searchableText: `${title} ${content}`.toLowerCase(),
                category,
                codeExamples,
            };

            // Extract API reference if applicable
            if (type === 'api') {
                docPage.apiReference = extractApiReference($, content);
            }

            docs.push(docPage);

            // Enqueue more links
            await enqueueLinks({
                globs: urlPatterns.include,
                exclude: urlPatterns.exclude,
            });
        },

        failedRequestHandler({ request, error }) {
            log.warning(`Failed to scrape ${request.url}: ${error}`);
        },
    });

    // Run crawler
    await crawler.run();

    await updateProgress(90, `Scraped ${docs.length} pages, building skill...`);

    // Build skill package
    const skillResult = await buildSkill(config.name, config.description, docs, 'scrape_docs', config.baseUrl);

    await updateProgress(100, `Skill built successfully with ${docs.length} pages`);

    return {
        skillId: skillResult.id,
        skillName: skillResult.name,
        pagesScraped: docs.length,
        filesGenerated: skillResult.files.map((f) => f.path),
        downloadUrl: skillResult.downloadUrl,
    };
}

/**
 * Generate URL patterns from start URLs and config
 */
function generateUrlPatterns(
    startUrls: string[],
    configPatterns?: { include?: string[]; exclude?: string[] }
): { include: string[]; exclude: string[] } {
    const includePatterns: string[] = configPatterns?.include ?? [];
    const excludePatterns: string[] = configPatterns?.exclude ?? [
        '**/*.pdf',
        '**/*.zip',
        '**/*.png',
        '**/*.jpg',
        '**/*.gif',
        '**/*.svg',
        '**/login**',
        '**/signup**',
        '**/auth**',
    ];

    // Auto-generate patterns from start URLs if none provided
    if (includePatterns.length === 0) {
        for (const url of startUrls) {
            try {
                const urlObj = new URL(url);
                const base = urlObj.origin + urlObj.pathname.replace(/\/$/, '');
                includePatterns.push(`${base}/**`);
            } catch {
                log.warning(`Invalid URL: ${url}`);
            }
        }
    }

    return { include: includePatterns, exclude: excludePatterns };
}

/**
 * Extract title from page
 */
function extractTitle($: CheerioAPI, selector?: string): string {
    if (selector) {
        const customTitle = $(selector).first().text().trim();
        if (customTitle) return customTitle;
    }

    // Fallback selectors
    return (
        $('h1').first().text().trim() ||
        $('title').first().text().trim() ||
        $('h2').first().text().trim() ||
        'Untitled'
    );
}

/**
 * Extract main content from page
 */
function extractContent(
    $: CheerioAPI,
    selector?: string,
    excludeSelectors?: string[]
): string {
    // Clone to avoid modifying original
    const $doc = $.root().clone();

    // Remove excluded elements
    const defaultExcludes = ['nav', 'header', 'footer', '.sidebar', '.navigation', 'script', 'style'];
    const allExcludes = [...defaultExcludes, ...(excludeSelectors ?? [])];

    for (const exclude of allExcludes) {
        $doc.find(exclude).remove();
    }

    // Try selectors in order
    const selectors = selector
        ? [selector, 'article', 'main', '.content', '.documentation', 'body']
        : ['article', 'main', '.content', '.documentation', 'body'];

    for (const sel of selectors) {
        const content = $doc.find(sel).text().trim();
        if (content && content.length > 50) {
            return cleanContent(content);
        }
    }

    return cleanContent($doc.text().trim());
}

/**
 * Clean content by removing extra whitespace
 */
function cleanContent(content: string): string {
    return content
        .replace(/\s+/g, ' ')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();
}

/**
 * Extract code blocks from page
 */
function extractCodeBlocks($: CheerioAPI, selector?: string): string[] {
    const codeSelector = selector ?? 'pre code, pre, .highlight code';
    const blocks: string[] = [];

    $(codeSelector).each((_: number, el: any) => {
        const code = $(el).text().trim();
        if (code && code.length > 10) {
            blocks.push(code);
        }
    });

    return blocks;
}

/**
 * Determine page type from URL and content
 */
function determinePageType(url: string, content: string): 'api' | 'guide' | 'example' {
    const urlLower = url.toLowerCase();
    const contentLower = content.toLowerCase();

    if (
        urlLower.includes('/api/') ||
        urlLower.includes('/reference/') ||
        urlLower.includes('/ref/') ||
        contentLower.includes('parameters:') ||
        contentLower.includes('returns:')
    ) {
        return 'api';
    }

    if (
        urlLower.includes('/example') ||
        urlLower.includes('/tutorial') ||
        urlLower.includes('/sample') ||
        contentLower.includes('example:') ||
        contentLower.includes('// example')
    ) {
        return 'example';
    }

    return 'guide';
}

/**
 * Determine category from URL and config
 */
function determineCategory(
    url: string,
    categories?: Record<string, { patterns?: string[] }>
): string | undefined {
    if (!categories) return undefined;

    const urlLower = url.toLowerCase();

    for (const [category, config] of Object.entries(categories)) {
        const patterns = config.patterns ?? [];
        for (const pattern of patterns) {
            if (urlLower.includes(pattern.toLowerCase())) {
                return category;
            }
        }
    }

    return undefined;
}

/**
 * Extract API reference information
 */
function extractApiReference(
    $: CheerioAPI,
    content: string
): { signature?: string; parameters?: string[]; returns?: string; example?: string } {
    const ref: { signature?: string; parameters?: string[]; returns?: string; example?: string } = {};

    // Try to find signature
    const signature = $('code.signature, .method-signature, .function-signature').first().text().trim();
    if (signature) ref.signature = signature;

    // Try to find parameters
    const params: string[] = [];
    $('.param, .parameter, dt').each((_: number, el: any) => {
        const param = $(el).text().trim();
        if (param && param.length < 100) {
            params.push(param);
        }
    });
    if (params.length > 0) ref.parameters = params;

    // Try to find return type
    const returnsMatch = content.match(/returns?:?\s*([^\n.]+)/i);
    if (returnsMatch) ref.returns = returnsMatch[1].trim();

    // Try to find example
    const example = $('pre code').first().text().trim();
    if (example && example.length > 10) ref.example = example;

    return ref;
}

/**
 * Estimate page count for a config (without full scrape)
 */
export async function estimatePageCount(config: SkillConfig): Promise<{
    estimatedPages: number;
    sampleUrls: string[];
}> {
    const startUrls = config.startUrls ?? (config.baseUrl ? [config.baseUrl] : []);
    if (startUrls.length === 0) {
        throw new Error('No start URLs provided');
    }

    const discoveredUrls: Set<string> = new Set();
    const maxDiscovery = 100; // Limit discovery for estimation

    const urlPatterns = generateUrlPatterns(startUrls, config.urlPatterns);

    const crawler = new CheerioCrawler({
        maxRequestsPerCrawl: maxDiscovery,
        maxConcurrency: 10,

        async requestHandler({ request, enqueueLinks }) {
            discoveredUrls.add(request.url);

            await enqueueLinks({
                globs: urlPatterns.include,
                exclude: urlPatterns.exclude,
            });
        },
    });

    await crawler.run(startUrls);

    return {
        estimatedPages: discoveredUrls.size,
        sampleUrls: Array.from(discoveredUrls).slice(0, 10),
    };
}
