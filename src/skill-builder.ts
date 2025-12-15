/**
 * Skill Builder
 * Builds Claude AI skill packages from scraped documentation
 */

import { Actor, log } from 'apify';
import archiver from 'archiver';
import { v4 as uuidv4 } from 'uuid';
import { DocPage, SkillPackage, SkillFile, JobType, CodeBlock } from './types.js';

/**
 * Build a skill package from documentation pages
 */
export async function buildSkill(
    name: string,
    description: string,
    docs: DocPage[],
    sourceType: JobType,
    sourceUrl?: string
): Promise<SkillPackage & { downloadUrl?: string }> {
    const skillId = `skill-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${uuidv4().substring(0, 6)}`;

    log.info(`Building skill: ${skillId} with ${docs.length} pages`);

    const files: SkillFile[] = [];

    // Generate SKILL.md (main skill file)
    const skillMd = generateSkillMd(name, description, docs, sourceType, sourceUrl);
    files.push({
        path: 'SKILL.md',
        content: skillMd,
        size: skillMd.length,
    });

    // Group docs by category
    const categories = groupByCategory(docs);

    // Generate single reference.md combining all categories and API docs
    const apiDocs = docs.filter((d) => d.type === 'api');
    const referenceContent = generateReferenceFile(categories, apiDocs);
    if (referenceContent) {
        files.push({
            path: 'reference.md',
            content: referenceContent,
            size: referenceContent.length,
        });
    }

    // Generate examples.md at root level
    const exampleDocs = docs.filter((d) => d.type === 'example' || (d.codeExamples && d.codeExamples.length > 0));
    if (exampleDocs.length > 0) {
        const examplesContent = generateExamplesFile(exampleDocs);
        files.push({
            path: 'examples.md',
            content: examplesContent,
            size: examplesContent.length,
        });
    }

    // Collect all code blocks from docs
    const allCodeBlocks: CodeBlock[] = [];
    for (const doc of docs) {
        if (doc.codeBlocks) {
            allCodeBlocks.push(...doc.codeBlocks);
        }
    }

    // Generate scripts/ directory for complete runnable scripts
    const scriptFiles = generateScriptsDirectory(allCodeBlocks);
    for (const scriptFile of scriptFiles) {
        files.push(scriptFile);
    }

    // Generate templates/ directory for template files
    const templateFiles = generateTemplatesDirectory(allCodeBlocks);
    for (const templateFile of templateFiles) {
        files.push(templateFile);
    }

    // Calculate stats
    const stats = {
        totalPages: docs.length,
        categories: Object.keys(categories).length,
        codeExamples: docs.reduce((sum, d) => sum + (d.codeExamples?.length ?? 0), 0),
    };

    // Create skill package
    const skillPackage: SkillPackage = {
        id: skillId,
        name,
        description,
        files,
        createdAt: new Date(),
        source: {
            type: sourceType,
            url: sourceUrl,
        },
        stats,
    };

    // Create ZIP and store in KV Store
    const zipBuffer = await createZipBuffer(files);
    await Actor.setValue(skillId, zipBuffer, { contentType: 'application/zip' });

    // Also store metadata
    await Actor.setValue(`${skillId}-meta`, {
        ...skillPackage,
        files: files.map((f) => ({ path: f.path, size: f.size })), // Don't store content in metadata
    });

    log.info(`Skill ${skillId} saved to Key-Value Store`);

    // Generate download URL
    const store = await Actor.openKeyValueStore();
    const storeId = store.id;
    const downloadUrl = `https://api.apify.com/v2/key-value-stores/${storeId}/records/${skillId}`;

    return {
        ...skillPackage,
        downloadUrl,
    };
}

/**
 * Generate SKILL.md content
 */
function generateSkillMd(
    name: string,
    description: string,
    docs: DocPage[],
    sourceType: JobType,
    sourceUrl?: string
): string {
    const lines: string[] = [
        `# ${name}`,
        '',
        description,
        '',
        '## Overview',
        '',
        `This skill contains documentation for ${name}, automatically generated from ${getSourceDescription(sourceType)}.`,
        '',
        '## Statistics',
        '',
        `- **Total Pages:** ${docs.length}`,
        `- **API References:** ${docs.filter((d) => d.type === 'api').length}`,
        `- **Guides:** ${docs.filter((d) => d.type === 'guide').length}`,
        `- **Examples:** ${docs.filter((d) => d.type === 'example').length}`,
        '',
    ];

    if (sourceUrl) {
        lines.push(`## Source`, '', `[${sourceUrl}](${sourceUrl})`, '');
    }

    // Add table of contents
    const categories = groupByCategory(docs);
    if (Object.keys(categories).length > 1) {
        lines.push('## Contents', '');
        for (const [category, categoryDocs] of Object.entries(categories)) {
            lines.push(`- **${category}** (${categoryDocs.length} pages)`);
        }
        lines.push('');
    }

    // Add quick start / getting started if found
    const gettingStarted = docs.find(
        (d) =>
            d.title.toLowerCase().includes('getting started') ||
            d.title.toLowerCase().includes('quick start') ||
            d.title.toLowerCase().includes('introduction')
    );

    if (gettingStarted) {
        lines.push('## Getting Started', '', gettingStarted.snippet, '', `See: ${gettingStarted.title}`, '');
    }

    // Add key concepts from guide docs
    const guideDocs = docs.filter((d) => d.type === 'guide').slice(0, 5);
    if (guideDocs.length > 0) {
        lines.push('## Key Topics', '');
        for (const doc of guideDocs) {
            lines.push(`- **${doc.title}**: ${doc.snippet.substring(0, 100)}...`);
        }
        lines.push('');
    }

    lines.push(
        '---',
        '',
        '*Generated by Skill Seekers MCP Server*'
    );

    return lines.join('\n');
}

/**
 * Get source description
 */
function getSourceDescription(sourceType: JobType): string {
    switch (sourceType) {
        case 'scrape_docs':
            return 'documentation website scraping';
        case 'scrape_github':
            return 'GitHub repository analysis';
        case 'scrape_pdf':
            return 'PDF document extraction';
        default:
            return 'automated scraping';
    }
}

/**
 * Group docs by category
 */
function groupByCategory(docs: DocPage[]): Record<string, DocPage[]> {
    const categories: Record<string, DocPage[]> = {};

    for (const doc of docs) {
        const category = doc.category ?? 'general';
        if (!categories[category]) {
            categories[category] = [];
        }
        categories[category].push(doc);
    }

    return categories;
}

/**
 * Generate combined reference.md file with all categories and API docs
 */
function generateReferenceFile(categories: Record<string, DocPage[]>, apiDocs: DocPage[]): string | null {
    const allDocs = Object.values(categories).flat();
    if (allDocs.length === 0 && apiDocs.length === 0) {
        return null;
    }

    const lines: string[] = [
        '# Reference Documentation',
        '',
    ];

    // Add each category section
    for (const [category, categoryDocs] of Object.entries(categories)) {
        lines.push(`## ${category.charAt(0).toUpperCase() + category.slice(1)}`, '');
        lines.push(`*${categoryDocs.length} pages in this section*`, '');

        for (const doc of categoryDocs) {
            lines.push(`### ${doc.title}`, '');

            if (doc.url) {
                lines.push(`*Source: ${doc.url}*`, '');
            }

            lines.push(doc.content, '');

            if (doc.codeExamples && doc.codeExamples.length > 0) {
                lines.push('#### Code Examples', '');
                for (const example of doc.codeExamples.slice(0, 3)) {
                    lines.push('```', example, '```', '');
                }
            }

            lines.push('---', '');
        }
    }

    // Add API Reference section if there are API docs
    if (apiDocs.length > 0) {
        lines.push('## API Reference', '');
        lines.push(`*${apiDocs.length} API entries*`, '');

        for (const doc of apiDocs) {
            lines.push(`### ${doc.title}`, '');

            if (doc.apiReference) {
                if (doc.apiReference.signature) {
                    lines.push('```', doc.apiReference.signature, '```', '');
                }

                if (doc.apiReference.parameters && doc.apiReference.parameters.length > 0) {
                    lines.push('#### Parameters', '');
                    for (const param of doc.apiReference.parameters) {
                        lines.push(`- ${param}`);
                    }
                    lines.push('');
                }

                if (doc.apiReference.returns) {
                    lines.push(`**Returns:** ${doc.apiReference.returns}`, '');
                }

                if (doc.apiReference.example) {
                    lines.push('#### Example', '', '```', doc.apiReference.example, '```', '');
                }
            }

            lines.push(doc.content.substring(0, 500), '');

            if (doc.url) {
                lines.push(`*See: ${doc.url}*`, '');
            }

            lines.push('---', '');
        }
    }

    return lines.join('\n');
}

/**
 * Generate scripts directory with runnable scripts
 * Format: scripts/helper.py
 */
function generateScriptsDirectory(codeBlocks: CodeBlock[]): SkillFile[] {
    const files: SkillFile[] = [];
    const scripts = codeBlocks.filter((cb) => cb.isScript && !cb.isTemplate);

    if (scripts.length === 0) return files;

    // Track used filenames to avoid duplicates
    const usedNames = new Set<string>();

    for (let i = 0; i < scripts.length; i++) {
        const script = scripts[i];

        // Generate filename: helper.py style
        let filename = generateScriptFilename(script, i);

        // Ensure uniqueness
        const ext = filename.includes('.') ? filename.substring(filename.lastIndexOf('.')) : '.py';
        let baseName = filename.replace(/\.[^.]+$/, '');
        let counter = 1;
        while (usedNames.has(filename)) {
            filename = `${baseName}_${counter}${ext}`;
            counter++;
        }
        usedNames.add(filename);

        files.push({
            path: `scripts/${filename}`,
            content: script.code,
            size: script.code.length,
        });
    }

    return files;
}

/**
 * Generate templates directory with template files
 * Format: templates/template.txt
 */
function generateTemplatesDirectory(codeBlocks: CodeBlock[]): SkillFile[] {
    const files: SkillFile[] = [];
    const templates = codeBlocks.filter((cb) => cb.isTemplate);

    if (templates.length === 0) return files;

    // Track used filenames to avoid duplicates
    const usedNames = new Set<string>();

    for (let i = 0; i < templates.length; i++) {
        const template = templates[i];

        // Generate filename: template.txt style
        let filename = generateTemplateFilename(template, i);

        // Ensure uniqueness
        let baseName = filename.replace(/\.txt$/, '');
        let counter = 1;
        while (usedNames.has(filename)) {
            filename = `${baseName}_${counter}.txt`;
            counter++;
        }
        usedNames.add(filename);

        files.push({
            path: `templates/${filename}`,
            content: template.code,
            size: template.code.length,
        });
    }

    return files;
}

/**
 * Generate script filename: helper.py style
 */
function generateScriptFilename(script: CodeBlock, index: number): string {
    // Use simple name based on title or default to "helper"
    const baseName = script.title
        ? script.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 20)
        : `helper${index > 0 ? `_${index + 1}` : ''}`;

    // Get extension based on language
    const extMap: Record<string, string> = {
        'python': '.py',
        'javascript': '.js',
        'typescript': '.ts',
        'bash': '.sh',
        'shell': '.sh',
        'ruby': '.rb',
        'go': '.go',
        'rust': '.rs',
        'java': '.java',
    };

    const ext = script.language ? (extMap[script.language] || '.py') : '.py';
    return `${baseName}${ext}`;
}

/**
 * Generate template filename: template.txt style
 */
function generateTemplateFilename(template: CodeBlock, index: number): string {
    // Use simple name based on title or default to "template"
    const baseName = template.title
        ? template.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').substring(0, 20)
        : `template${index > 0 ? `_${index + 1}` : ''}`;

    return `${baseName}.txt`;
}

/**
 * Generate examples file
 */
function generateExamplesFile(docs: DocPage[]): string {
    const lines: string[] = [
        '# Code Examples',
        '',
        `*${docs.length} pages with examples*`,
        '',
    ];

    for (const doc of docs) {
        if (!doc.codeExamples || doc.codeExamples.length === 0) continue;

        lines.push(`## ${doc.title}`, '');

        for (let i = 0; i < doc.codeExamples.length; i++) {
            if (doc.codeExamples.length > 1) {
                lines.push(`### Example ${i + 1}`, '');
            }
            lines.push('```', doc.codeExamples[i], '```', '');
        }

        if (doc.url) {
            lines.push(`*Source: ${doc.url}*`, '');
        }

        lines.push('---', '');
    }

    return lines.join('\n');
}

/**
 * Create ZIP buffer from files
 */
async function createZipBuffer(files: SkillFile[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.on('data', (chunk) => chunks.push(chunk));
        archive.on('end', () => resolve(Buffer.concat(chunks)));
        archive.on('error', reject);

        for (const file of files) {
            archive.append(file.content, { name: file.path });
        }

        archive.finalize();
    });
}

/**
 * List all skills in KV Store
 */
export async function listSkills(): Promise<Array<{
    id: string;
    name: string;
    description: string;
    createdAt: Date;
    stats: { totalPages: number; categories: number; codeExamples: number };
    downloadUrl: string;
}>> {
    const skills: Array<{
        id: string;
        name: string;
        description: string;
        createdAt: Date;
        stats: { totalPages: number; categories: number; codeExamples: number };
        downloadUrl: string;
    }> = [];

    const store = await Actor.openKeyValueStore();
    const storeId = store.id;

    await store.forEachKey(async (key) => {
        if (key.startsWith('skill-') && key.endsWith('-meta')) {
            const meta = await Actor.getValue<{
                id: string;
                name: string;
                description: string;
                createdAt: string;
                stats: { totalPages: number; categories: number; codeExamples: number };
            }>(key);

            if (meta) {
                const skillId = key.replace('-meta', '');
                skills.push({
                    id: skillId,
                    name: meta.name,
                    description: meta.description,
                    createdAt: new Date(meta.createdAt),
                    stats: meta.stats,
                    downloadUrl: `https://api.apify.com/v2/key-value-stores/${storeId}/records/${skillId}`,
                });
            }
        }
    });

    return skills.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Get skill by ID
 */
export async function getSkill(skillId: string): Promise<{
    id: string;
    name: string;
    description: string;
    createdAt: Date;
    stats: { totalPages: number; categories: number; codeExamples: number };
    downloadUrl: string;
} | null> {
    const meta = await Actor.getValue<{
        id: string;
        name: string;
        description: string;
        createdAt: string;
        stats: { totalPages: number; categories: number; codeExamples: number };
    }>(`${skillId}-meta`);

    if (!meta) return null;

    const store = await Actor.openKeyValueStore();
    const storeId = store.id;

    return {
        id: skillId,
        name: meta.name,
        description: meta.description,
        createdAt: new Date(meta.createdAt),
        stats: meta.stats,
        downloadUrl: `https://api.apify.com/v2/key-value-stores/${storeId}/records/${skillId}`,
    };
}
