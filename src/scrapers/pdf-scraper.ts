/**
 * PDF Scraper
 * Extracts text and structure from PDF files
 */

import { createRequire } from 'module';
import { Job, JobResult, PdfData, PdfSection, DocPage } from '../types.js';
import { buildSkill } from '../skill-builder.js';

// Use createRequire for CommonJS pdf-parse module
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

/**
 * Scrape a PDF file
 */
export async function scrapePdf(
    job: Job,
    updateProgress: (progress: number, message: string) => Promise<void>
): Promise<JobResult> {
    const config = job.config;

    const pdfSource = config.pdfUrl ?? config.pdfPath;
    if (!pdfSource) {
        throw new Error('PDF URL or path not specified');
    }

    await updateProgress(10, `Fetching PDF: ${pdfSource}...`);

    // Fetch PDF data
    let pdfBuffer: Buffer;

    if (pdfSource.startsWith('http://') || pdfSource.startsWith('https://')) {
        // Fetch from URL
        const response = await fetch(pdfSource);
        if (!response.ok) {
            throw new Error(`Failed to fetch PDF: ${response.status} ${response.statusText}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        pdfBuffer = Buffer.from(arrayBuffer);
    } else {
        throw new Error('Only HTTP/HTTPS URLs are supported for PDF scraping in Apify environment');
    }

    await updateProgress(30, 'Parsing PDF content...');

    // Parse PDF
    const pdfData = await parsePdf(pdfBuffer);

    await updateProgress(60, `Extracted ${pdfData.pages} pages, processing sections...`);

    // Convert to doc pages
    const docs = convertPdfToDocPages(pdfData, config.name ?? 'pdf-document');

    await updateProgress(80, 'Building skill package...');

    // Build skill
    const skillResult = await buildSkill(
        config.name ?? 'pdf-document',
        config.description ?? `Documentation extracted from PDF`,
        docs,
        'scrape_pdf',
        pdfSource
    );

    await updateProgress(100, `Skill built from PDF with ${docs.length} pages`);

    return {
        skillId: skillResult.id,
        skillName: skillResult.name,
        pagesScraped: docs.length,
        filesGenerated: skillResult.files.map((f) => f.path),
        downloadUrl: skillResult.downloadUrl,
    };
}

/**
 * Parse PDF and extract structured content
 */
async function parsePdf(buffer: Buffer): Promise<PdfData> {
    const data = await pdf(buffer);

    // Extract metadata
    const metadata: Record<string, string> = {};
    if (data.info) {
        if (data.info.Title) metadata.Title = data.info.Title;
        if (data.info.Author) metadata.Author = data.info.Author;
        if (data.info.Subject) metadata.Subject = data.info.Subject;
        if (data.info.Creator) metadata.Creator = data.info.Creator;
    }

    // Extract title from metadata or first line
    const title = metadata.Title ?? extractTitleFromContent(data.text);

    // Split into sections
    const sections = extractSections(data.text, data.numpages);

    return {
        title,
        content: data.text,
        pages: data.numpages,
        metadata,
        sections,
    };
}

/**
 * Extract title from content (first heading or first line)
 */
function extractTitleFromContent(content: string): string {
    const lines = content.split('\n').filter((l) => l.trim());

    for (const line of lines.slice(0, 10)) {
        const trimmed = line.trim();
        // Look for heading-like patterns
        if (trimmed.length > 3 && trimmed.length < 100) {
            // Skip if it looks like a paragraph
            if (!trimmed.endsWith('.') && !trimmed.endsWith(',')) {
                return trimmed;
            }
        }
    }

    return 'Untitled Document';
}

/**
 * Extract sections from PDF content
 */
function extractSections(content: string, totalPages: number): PdfSection[] {
    const sections: PdfSection[] = [];
    const lines = content.split('\n');

    let currentSection: PdfSection | null = null;
    let currentContent: string[] = [];
    let currentCodeBlocks: string[] = [];
    let inCodeBlock = false;
    let codeBlockContent: string[] = [];

    // Estimate page boundaries (rough approximation)
    const linesPerPage = Math.ceil(lines.length / totalPages);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const pageNumber = Math.floor(i / linesPerPage) + 1;

        // Detect code blocks (common patterns)
        if (isCodeBlockStart(line)) {
            inCodeBlock = true;
            codeBlockContent = [];
            continue;
        }

        if (inCodeBlock) {
            if (isCodeBlockEnd(line)) {
                inCodeBlock = false;
                currentCodeBlocks.push(codeBlockContent.join('\n'));
            } else {
                codeBlockContent.push(line);
            }
            continue;
        }

        // Detect section headings
        if (isSectionHeading(line)) {
            // Save previous section
            if (currentSection) {
                currentSection.content = currentContent.join('\n').trim();
                currentSection.codeBlocks = currentCodeBlocks.length > 0 ? currentCodeBlocks : undefined;
                sections.push(currentSection);
            }

            // Start new section
            currentSection = {
                title: line.trim(),
                content: '',
                pageNumber,
            };
            currentContent = [];
            currentCodeBlocks = [];
        } else if (currentSection) {
            currentContent.push(line);
        } else {
            // Content before first section - create intro section
            if (line.trim()) {
                currentSection = {
                    title: 'Introduction',
                    content: '',
                    pageNumber: 1,
                };
                currentContent = [line];
            }
        }
    }

    // Save last section
    if (currentSection) {
        currentSection.content = currentContent.join('\n').trim();
        currentSection.codeBlocks = currentCodeBlocks.length > 0 ? currentCodeBlocks : undefined;
        sections.push(currentSection);
    }

    // If no sections found, create one from full content
    if (sections.length === 0) {
        sections.push({
            title: 'Document Content',
            content: content,
            pageNumber: 1,
        });
    }

    return sections;
}

/**
 * Check if line is a section heading
 */
function isSectionHeading(line: string): boolean {
    const trimmed = line.trim();

    // Too short or too long
    if (trimmed.length < 3 || trimmed.length > 80) return false;

    // Numbered heading (1. Title, 1.1 Title, etc.)
    if (/^\d+(\.\d+)*\.?\s+[A-Z]/.test(trimmed)) return true;

    // All caps heading
    if (trimmed === trimmed.toUpperCase() && /^[A-Z\s]+$/.test(trimmed) && trimmed.length > 5) return true;

    // Chapter/Section prefix
    if (/^(Chapter|Section|Part)\s+\d/i.test(trimmed)) return true;

    // Title case, short, no punctuation at end
    if (
        !trimmed.endsWith('.') &&
        !trimmed.endsWith(',') &&
        /^[A-Z][a-z]/.test(trimmed) &&
        trimmed.length < 50
    ) {
        // Additional check: followed by blank line or content indentation
        return true;
    }

    return false;
}

/**
 * Check if line starts a code block
 */
function isCodeBlockStart(line: string): boolean {
    const trimmed = line.trim();
    return (
        trimmed.startsWith('```') ||
        trimmed.startsWith('~~~') ||
        /^(Example|Code|Listing)(\s+\d+)?:/i.test(trimmed)
    );
}

/**
 * Check if line ends a code block
 */
function isCodeBlockEnd(line: string): boolean {
    const trimmed = line.trim();
    return trimmed === '```' || trimmed === '~~~';
}

/**
 * Convert PDF data to documentation pages
 */
function convertPdfToDocPages(pdfData: PdfData, skillName: string): DocPage[] {
    const docs: DocPage[] = [];

    // Main document page
    docs.push({
        id: 'docs-1',
        source: skillName,
        title: pdfData.title,
        content: formatDocumentOverview(pdfData),
        snippet: `PDF document with ${pdfData.pages} pages`,
        type: 'guide',
        url: '',
        searchableText: `${pdfData.title} ${pdfData.content}`.toLowerCase().substring(0, 10000),
        category: 'overview',
    });

    // Section pages
    for (const section of pdfData.sections) {
        if (section.content.length < 50) continue; // Skip very short sections

        docs.push({
            id: `docs-${docs.length + 1}`,
            source: skillName,
            title: section.title,
            content: formatSection(section),
            snippet: section.content.substring(0, 200) + '...',
            type: section.codeBlocks && section.codeBlocks.length > 0 ? 'example' : 'guide',
            url: '',
            searchableText: `${section.title} ${section.content}`.toLowerCase(),
            category: 'content',
            codeExamples: section.codeBlocks,
        });
    }

    return docs;
}

/**
 * Format document overview
 */
function formatDocumentOverview(pdfData: PdfData): string {
    const lines: string[] = [
        `# ${pdfData.title}`,
        '',
        `**Pages:** ${pdfData.pages}`,
        '',
    ];

    // Add metadata
    if (Object.keys(pdfData.metadata ?? {}).length > 0) {
        lines.push('## Document Information', '');
        for (const [key, value] of Object.entries(pdfData.metadata ?? {})) {
            lines.push(`- **${key}:** ${value}`);
        }
        lines.push('');
    }

    // Add table of contents
    if (pdfData.sections.length > 1) {
        lines.push('## Table of Contents', '');
        for (const section of pdfData.sections) {
            lines.push(`- ${section.title} (page ${section.pageNumber})`);
        }
    }

    return lines.join('\n');
}

/**
 * Format section content
 */
function formatSection(section: PdfSection): string {
    const lines: string[] = [
        `# ${section.title}`,
        `*Page ${section.pageNumber}*`,
        '',
        section.content,
    ];

    if (section.codeBlocks && section.codeBlocks.length > 0) {
        lines.push('', '## Code Examples', '');
        for (const code of section.codeBlocks) {
            lines.push('```', code, '```', '');
        }
    }

    return lines.join('\n');
}
