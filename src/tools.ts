/**
 * MCP Tool Definitions for Skill Seekers
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { log } from 'apify';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

import { SkillConfig } from './types.js';
import { createJob, getJob, getAllJobs } from './job-manager.js';
import { estimatePageCount } from './scrapers/doc-scraper.js';
import { listSkills, getSkill } from './skill-builder.js';
import { generateSkillMdWithClaude, getSkillInstallPath, SkillType, createCloudSkill } from './openrouter.js';
import { getAnthropicApiKey } from './main.js';
import { Actor } from 'apify';
import JSZip from 'jszip';

/**
 * Register all MCP tools
 */
export function registerTools(server: McpServer): void {
    // Tool 1: Estimate Pages
    server.registerTool(
        'estimate_pages',
        {
            description:
                'Estimate how many pages will be scraped from a documentation URL. Fast preview without full scraping.',
            inputSchema: {
                url: z.string().url().describe('Documentation URL to estimate'),
                maxDiscovery: z.number().optional().default(100).describe('Maximum pages to discover during estimation'),
            },
        },
        async ({ url, maxDiscovery }): Promise<CallToolResult> => {
            log.info(`Estimating pages for: ${url}`);

            try {
                const config: SkillConfig = {
                    name: 'estimate',
                    description: '',
                    baseUrl: url,
                    maxPages: maxDiscovery,
                };

                const result = await estimatePageCount(config);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    success: true,
                                    estimatedPages: result.estimatedPages,
                                    sampleUrls: result.sampleUrls,
                                    message: `Found approximately ${result.estimatedPages} pages.`,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        },
                    ],
                };
            }
        }
    );

    // Tool 3: Scrape Docs
    server.registerTool(
        'scrape_docs',
        {
            description:
                'Start a documentation scraping job. Returns a job ID that can be used to check progress with get_job_status.',
            inputSchema: {
                config: z
                    .object({
                        name: z.string().describe('Skill name'),
                        description: z.string().describe('Skill description'),
                        baseUrl: z.string().url().optional().describe('Base documentation URL'),
                        startUrls: z.array(z.string()).optional().describe('List of URLs to start from'),
                        maxPages: z.number().optional().describe('Maximum pages to scrape'),
                    })
                    .describe('Scraping configuration'),
            },
        },
        async ({ config }): Promise<CallToolResult> => {
            log.info(`Starting docs scrape job: ${config.name}`);

            try {
                const job = await createJob('scrape_docs', config as SkillConfig);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    success: true,
                                    jobId: job.id,
                                    status: job.status,
                                    message: `Job ${job.id} created. Use get_job_status to check progress.`,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        },
                    ],
                };
            }
        }
    );

    // Tool 4: Scrape GitHub
    server.registerTool(
        'scrape_github',
        {
            description:
                'Start a GitHub repository scraping job. Extracts README, issues, releases, and file structure.',
            inputSchema: {
                repo: z.string().describe('GitHub repository (owner/repo format, e.g., facebook/react)'),
                name: z.string().optional().describe('Skill name (defaults to repo name)'),
                description: z.string().optional().describe('Skill description'),
                includeIssues: z.boolean().optional().default(true).describe('Include GitHub issues'),
                includeReleases: z.boolean().optional().default(true).describe('Include releases'),
                maxIssues: z.number().optional().default(100).describe('Maximum issues to fetch'),
            },
        },
        async ({ repo, name, description, includeIssues, includeReleases, maxIssues }): Promise<CallToolResult> => {
            log.info(`Starting GitHub scrape job: ${repo}`);

            try {
                const config: SkillConfig = {
                    name: name ?? repo.split('/')[1] ?? 'github-repo',
                    description: description ?? `Documentation from ${repo}`,
                    repo,
                    includeIssues,
                    includeReleases,
                    maxIssues,
                };

                const job = await createJob('scrape_github', config);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    success: true,
                                    jobId: job.id,
                                    status: job.status,
                                    message: `Job ${job.id} created for ${repo}. Use get_job_status to check progress.`,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        },
                    ],
                };
            }
        }
    );

    // Tool 5: Scrape PDF
    server.registerTool(
        'scrape_pdf',
        {
            description: 'Start a PDF scraping job. Extracts text and structure from PDF files.',
            inputSchema: {
                pdfUrl: z.string().url().describe('URL of the PDF file'),
                name: z.string().describe('Skill name'),
                description: z.string().optional().describe('Skill description'),
            },
        },
        async ({ pdfUrl, name, description }): Promise<CallToolResult> => {
            log.info(`Starting PDF scrape job: ${pdfUrl}`);

            try {
                const config: SkillConfig = {
                    name,
                    description: description ?? `Documentation extracted from PDF`,
                    pdfUrl,
                };

                const job = await createJob('scrape_pdf', config);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    success: true,
                                    jobId: job.id,
                                    status: job.status,
                                    message: `Job ${job.id} created. Use get_job_status to check progress.`,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        },
                    ],
                };
            }
        }
    );

    // Tool 6: Get Job Status
    server.registerTool(
        'get_job_status',
        {
            description: 'Check the status and progress of a scraping job.',
            inputSchema: {
                jobId: z.string().describe('Job ID returned from scrape_docs, scrape_github, or scrape_pdf'),
            },
        },
        async ({ jobId }): Promise<CallToolResult> => {
            log.info(`Getting job status: ${jobId}`);

            const job = await getJob(jobId);

            if (!job) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: `Job ${jobId} not found`,
                            }),
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                success: true,
                                jobId: job.id,
                                type: job.type,
                                status: job.status,
                                progress: job.progress,
                                message: job.message,
                                result: job.result,
                                error: job.error,
                                createdAt: job.createdAt,
                                updatedAt: job.updatedAt,
                                completedAt: job.completedAt,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    // Tool 7: List Jobs
    server.registerTool(
        'list_jobs',
        {
            description: 'List all scraping jobs and their status.',
            inputSchema: {},
        },
        async (): Promise<CallToolResult> => {
            log.info('Listing all jobs');

            const jobs = getAllJobs();

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                success: true,
                                totalJobs: jobs.length,
                                jobs: jobs.map((j) => ({
                                    id: j.id,
                                    type: j.type,
                                    status: j.status,
                                    progress: j.progress,
                                    message: j.message,
                                    createdAt: j.createdAt,
                                })),
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    // Tool 8: List Skills
    server.registerTool(
        'list_skills',
        {
            description: 'List all generated skills available for download.',
            inputSchema: {},
        },
        async (): Promise<CallToolResult> => {
            log.info('Listing all skills');

            try {
                const skills = await listSkills();

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    success: true,
                                    totalSkills: skills.length,
                                    skills,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        },
                    ],
                };
            }
        }
    );

    // Tool 9: Get Skill
    server.registerTool(
        'get_skill',
        {
            description: 'Get information and download URL for a specific skill.',
            inputSchema: {
                skillId: z.string().describe('Skill ID'),
            },
        },
        async ({ skillId }): Promise<CallToolResult> => {
            log.info(`Getting skill: ${skillId}`);

            try {
                const skill = await getSkill(skillId);

                if (!skill) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    success: false,
                                    error: `Skill ${skillId} not found`,
                                }),
                            },
                        ],
                    };
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    success: true,
                                    skill,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        },
                    ],
                };
            }
        }
    );

    // Tool 10: List Preset Configs
    server.registerTool(
        'list_configs',
        {
            description: 'List available preset configurations for popular frameworks and libraries.',
            inputSchema: {},
        },
        async (): Promise<CallToolResult> => {
            log.info('Listing preset configs');

            try {
                const configsDir = join(process.cwd(), 'configs');
                const configs: Array<{
                    name: string;
                    file: string;
                    description: string;
                    baseUrl: string;
                }> = [];

                if (existsSync(configsDir)) {
                    const files = readdirSync(configsDir).filter((f) => f.endsWith('.json'));

                    for (const file of files) {
                        try {
                            const content = readFileSync(join(configsDir, file), 'utf-8');
                            const config = JSON.parse(content);
                            configs.push({
                                name: config.name ?? file.replace('.json', ''),
                                file,
                                description: config.description ?? '',
                                baseUrl: config.base_url ?? config.baseUrl ?? '',
                            });
                        } catch {
                            // Skip invalid configs
                        }
                    }
                }

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    success: true,
                                    totalConfigs: configs.length,
                                    configs,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        },
                    ],
                };
            }
        }
    );

    // Tool 11: Install Skill
    server.registerTool(
        'install_skill',
        {
            description:
                'Generate properly formatted Claude Code skill files ready for installation. Uses AI to create a well-structured SKILL.md with YAML frontmatter. For local skills (personal/project), returns files to save. For cloud skills, creates the skill directly in your Anthropic account.',
            inputSchema: {
                skillId: z.string().describe('Skill ID from a completed scraping job'),
                skillType: z
                    .enum(['personal', 'project', 'cloud'])
                    .describe(
                        'Where to install the skill: "personal" (~/.claude/skills/) for your own use across all projects, "project" (.claude/skills/) for team sharing via git, or "cloud" to create directly in your Anthropic account (requires X-Anthropic-Api-Key header)'
                    ),
            },
        },
        async ({ skillId, skillType }): Promise<CallToolResult> => {
            log.info(`Installing skill: ${skillId} as ${skillType}`);

            try {
                // Get skill metadata
                const skillMeta = await getSkill(skillId);
                if (!skillMeta) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    success: false,
                                    error: `Skill ${skillId} not found`,
                                }),
                            },
                        ],
                    };
                }

                // Download and extract the skill ZIP
                const zipBuffer = await Actor.getValue<Buffer>(skillId);
                if (!zipBuffer) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify({
                                    success: false,
                                    error: `Skill ZIP not found for ${skillId}`,
                                }),
                            },
                        ],
                    };
                }

                // Extract files from ZIP
                const zip = await JSZip.loadAsync(zipBuffer);
                const files: Array<{ path: string; content: string }> = [];
                let sampleContent = '';

                for (const [filename, file] of Object.entries(zip.files)) {
                    if (!file.dir) {
                        const content = await file.async('string');
                        files.push({ path: filename, content });

                        // Collect sample content for AI generation
                        if (filename.endsWith('.md') && filename !== 'SKILL.md') {
                            sampleContent += content.substring(0, 1500) + '\n\n';
                        }
                    }
                }

                // Get Apify token for OpenRouter
                const apifyToken = process.env.APIFY_TOKEN;
                let skillMdContent: string;

                if (apifyToken) {
                    // Generate proper SKILL.md with Claude via OpenRouter
                    skillMdContent = await generateSkillMdWithClaude(
                        skillMeta.name,
                        skillMeta.description,
                        skillMeta.downloadUrl,
                        sampleContent,
                        apifyToken
                    );
                } else {
                    // Fallback: find existing SKILL.md or generate basic one
                    const existingSkillMd = files.find((f) => f.path === 'SKILL.md');
                    if (existingSkillMd) {
                        // Add frontmatter to existing content
                        const safeName = skillMeta.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
                        skillMdContent = `---
name: ${safeName}
description: ${skillMeta.description}. Use when working with ${skillMeta.name}.
---

${existingSkillMd.content}`;
                    } else {
                        skillMdContent = `---
name: ${skillMeta.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}
description: ${skillMeta.description}. Use when working with ${skillMeta.name}.
---

# ${skillMeta.name}

${skillMeta.description}

## References

See the reference files for complete documentation.
`;
                    }
                }

                // Prepare output files (SKILL.md + reference files)
                const outputFiles: Array<{ path: string; content: string }> = [
                    { path: 'SKILL.md', content: skillMdContent },
                ];

                // Add other files (reference.md, examples.md, scripts/, templates/)
                for (const file of files) {
                    if (file.path !== 'SKILL.md') {
                        outputFiles.push({ path: file.path, content: file.content });
                    }
                }

                // Handle cloud skill creation
                if (skillType === 'cloud') {
                    const anthropicApiKey = getAnthropicApiKey();

                    if (!anthropicApiKey) {
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        success: false,
                                        error: 'Cloud skill creation requires an Anthropic API key. Add the MCP server with: claude mcp add --transport http skill-seekers URL --header "Authorization: Bearer APIFY_TOKEN" --header "X-Anthropic-Api-Key: YOUR_ANTHROPIC_API_KEY"',
                                    }),
                                },
                            ],
                        };
                    }

                    try {
                        const cloudSkill = await createCloudSkill(
                            skillMeta.name,
                            skillMeta.name, // display_title
                            outputFiles,
                            anthropicApiKey
                        );

                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify(
                                        {
                                            success: true,
                                            skillId: cloudSkill.id,
                                            skillName: skillMeta.name,
                                            skillType: 'cloud',
                                            cloudSkillId: cloudSkill.id,
                                            cloudSkillVersion: cloudSkill.latestVersion,
                                            message: `Cloud skill "${skillMeta.name}" created successfully! It is now available in your Anthropic account and can be used across all your Claude interactions.`,
                                        },
                                        null,
                                        2
                                    ),
                                },
                            ],
                        };
                    } catch (error) {
                        log.error(`Failed to create cloud skill: ${error}`);
                        return {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        success: false,
                                        error: `Failed to create cloud skill: ${error instanceof Error ? error.message : String(error)}`,
                                    }),
                                },
                            ],
                        };
                    }
                }

                // For local skills (personal/project), return files
                const installPath = getSkillInstallPath(skillType as SkillType, skillMeta.name);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    success: true,
                                    skillId,
                                    skillName: skillMeta.name,
                                    skillType,
                                    installPath,
                                    files: outputFiles.map((f) => ({
                                        path: f.path,
                                        content: f.content,
                                    })),
                                    instructions: `To install this skill, create the directory "${installPath}" and save the files there. The SKILL.md file contains the main skill with YAML frontmatter, and the other files are reference documentation.`,
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error) {
                log.error(`Failed to install skill: ${error}`);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        },
                    ],
                };
            }
        }
    );

    // Tool 11: Validate Config
    server.registerTool(
        'validate_config',
        {
            description: 'Validate a scraping configuration for errors before running.',
            inputSchema: {
                config: z
                    .object({
                        name: z.string().describe('Skill name'),
                        description: z.string().describe('Skill description'),
                        baseUrl: z.string().url().optional().describe('Base documentation URL'),
                        startUrls: z.array(z.string()).optional().describe('List of URLs to start from'),
                        maxPages: z.number().optional().describe('Maximum pages to scrape'),
                        rateLimit: z.number().optional().describe('Delay between requests'),
                        repo: z.string().optional().describe('GitHub repository (for GitHub scraping)'),
                        pdfUrl: z.string().optional().describe('PDF URL (for PDF scraping)'),
                    })
                    .describe('Configuration to validate'),
            },
        },
        async ({ config }): Promise<CallToolResult> => {
            log.info(`Validating config: ${config.name}`);

            const errors: string[] = [];
            const warnings: string[] = [];

            // Check required fields
            if (!config.name || config.name.trim() === '') {
                errors.push('Missing required field: name');
            } else if (!/^[a-z0-9-]+$/.test(config.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'))) {
                warnings.push('Name should be lowercase alphanumeric with hyphens');
            }

            if (!config.description || config.description.trim() === '') {
                errors.push('Missing required field: description');
            }

            // Check source - must have at least one
            const hasDocSource = config.baseUrl || (config.startUrls && config.startUrls.length > 0);
            const hasGitHubSource = config.repo;
            const hasPdfSource = config.pdfUrl;

            if (!hasDocSource && !hasGitHubSource && !hasPdfSource) {
                errors.push('Must specify at least one source: baseUrl/startUrls, repo, or pdfUrl');
            }

            // Validate URLs
            if (config.baseUrl) {
                try {
                    new URL(config.baseUrl);
                } catch {
                    errors.push(`Invalid baseUrl: ${config.baseUrl}`);
                }
            }

            if (config.startUrls) {
                for (const url of config.startUrls) {
                    try {
                        new URL(url);
                    } catch {
                        errors.push(`Invalid startUrl: ${url}`);
                    }
                }
            }

            // Validate numeric fields
            if (config.maxPages !== undefined && config.maxPages < 1) {
                warnings.push('maxPages should be at least 1');
            }

            if (config.rateLimit !== undefined && config.rateLimit < 0) {
                warnings.push('rateLimit should be non-negative');
            }

            // Validate GitHub repo format
            if (config.repo && !config.repo.includes('/')) {
                errors.push('GitHub repo must be in owner/repo format (e.g., facebook/react)');
            }

            const isValid = errors.length === 0;

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                success: isValid,
                                valid: isValid,
                                errors: errors.length > 0 ? errors : undefined,
                                warnings: warnings.length > 0 ? warnings : undefined,
                                config: isValid ? config : undefined,
                                message: isValid
                                    ? `Config "${config.name}" is valid and ready for scraping.`
                                    : `Config has ${errors.length} error(s). Please fix before scraping.`,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    // Tool 12: Split Config
    server.registerTool(
        'split_config',
        {
            description:
                'Split a large documentation config into multiple smaller focused skills. Use for documentation with 5000+ pages.',
            inputSchema: {
                config: z
                    .object({
                        name: z.string().describe('Skill name'),
                        description: z.string().describe('Skill description'),
                        baseUrl: z.string().url().describe('Base documentation URL'),
                        maxPages: z.number().optional().describe('Maximum pages to scrape'),
                    })
                    .describe('Configuration to split'),
                targetPagesPerSkill: z
                    .number()
                    .optional()
                    .default(2000)
                    .describe('Target pages per sub-skill (default: 2000)'),
                categories: z
                    .array(
                        z.object({
                            name: z.string().describe('Category name'),
                            patterns: z.array(z.string()).describe('URL patterns to match'),
                            description: z.string().optional().describe('Category description'),
                        })
                    )
                    .optional()
                    .describe('Categories to split by (auto-detected if not provided)'),
            },
        },
        async ({ config, targetPagesPerSkill, categories }): Promise<CallToolResult> => {
            log.info(`Splitting config: ${config.name}`);

            try {
                // If no categories provided, suggest auto-detection based on URL structure
                let splitCategories = categories;

                if (!splitCategories || splitCategories.length === 0) {
                    // Auto-detect common documentation patterns
                    const commonPatterns = [
                        { name: 'getting-started', patterns: ['**/getting-started/**', '**/quickstart/**', '**/intro/**', '**/tutorial/**'], description: 'Getting started guides and tutorials' },
                        { name: 'api-reference', patterns: ['**/api/**', '**/reference/**', '**/ref/**'], description: 'API reference documentation' },
                        { name: 'guides', patterns: ['**/guide/**', '**/guides/**', '**/how-to/**'], description: 'How-to guides and walkthroughs' },
                        { name: 'examples', patterns: ['**/example/**', '**/examples/**', '**/samples/**'], description: 'Code examples and samples' },
                        { name: 'concepts', patterns: ['**/concepts/**', '**/architecture/**', '**/overview/**'], description: 'Core concepts and architecture' },
                    ];

                    splitCategories = commonPatterns;
                }

                // Generate sub-configs
                const subConfigs = splitCategories.map((category, index) => ({
                    name: `${config.name}-${category.name}`,
                    description: category.description || `${config.description} - ${category.name}`,
                    baseUrl: config.baseUrl,
                    maxPages: targetPagesPerSkill,
                    urlPatterns: {
                        include: category.patterns,
                        exclude: ['**/login**', '**/signup**', '**/*.pdf', '**/*.zip'],
                    },
                    parentSkill: config.name,
                    categoryIndex: index,
                }));

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    success: true,
                                    originalConfig: config.name,
                                    targetPagesPerSkill,
                                    subSkillCount: subConfigs.length,
                                    subConfigs,
                                    message: `Config split into ${subConfigs.length} sub-skills. Use scrape_docs with each sub-config, then generate_router to create a hub skill.`,
                                    nextSteps: [
                                        'Run scrape_docs for each sub-config',
                                        'Use generate_router to create a router skill',
                                        'Install all skills including the router',
                                    ],
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        },
                    ],
                };
            }
        }
    );

    // Tool 13: Generate Router
    server.registerTool(
        'generate_router',
        {
            description:
                'Generate a router/hub skill that directs users to the appropriate sub-skill. Use after splitting large documentation.',
            inputSchema: {
                name: z.string().describe('Router skill name (e.g., "godot-router")'),
                description: z.string().describe('Description of the documentation covered'),
                subSkills: z
                    .array(
                        z.object({
                            name: z.string().describe('Sub-skill name'),
                            description: z.string().describe('What this sub-skill covers'),
                            topics: z.array(z.string()).describe('Key topics/keywords for routing'),
                        })
                    )
                    .describe('List of sub-skills to route to'),
            },
        },
        async ({ name, description, subSkills }): Promise<CallToolResult> => {
            log.info(`Generating router: ${name}`);

            try {
                // Generate router SKILL.md content
                const routerContent = generateRouterSkillContent(name, description, subSkills);

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(
                                {
                                    success: true,
                                    routerName: name,
                                    subSkillCount: subSkills.length,
                                    files: [
                                        {
                                            path: 'SKILL.md',
                                            content: routerContent,
                                        },
                                    ],
                                    message: `Router skill "${name}" generated with ${subSkills.length} sub-skill routes. Install this alongside your sub-skills.`,
                                    usage: 'When users ask questions, this router will help Claude determine which sub-skill contains the relevant information.',
                                },
                                null,
                                2
                            ),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        },
                    ],
                };
            }
        }
    );

    log.info('Registered 13 MCP tools');
}

/**
 * Generate router skill SKILL.md content
 */
function generateRouterSkillContent(
    name: string,
    description: string,
    subSkills: Array<{ name: string; description: string; topics: string[] }>
): string {
    const lines: string[] = [
        '---',
        `name: ${name}`,
        `description: ${description}. Routes questions to the appropriate specialized skill.`,
        '---',
        '',
        `# ${name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}`,
        '',
        description,
        '',
        '## How to Use This Router',
        '',
        'This is a **router skill** that helps you find the right documentation. When you have a question, check the routing table below to find which skill has the answer.',
        '',
        '## Routing Table',
        '',
        '| Topic | Use Skill | Description |',
        '|-------|-----------|-------------|',
    ];

    // Add routing table rows
    for (const skill of subSkills) {
        const topicsStr = skill.topics.slice(0, 3).join(', ');
        lines.push(`| ${topicsStr} | ${skill.name} | ${skill.description} |`);
    }

    lines.push('');
    lines.push('## Detailed Routing');
    lines.push('');

    // Add detailed sections for each sub-skill
    for (const skill of subSkills) {
        lines.push(`### ${skill.name}`);
        lines.push('');
        lines.push(skill.description);
        lines.push('');
        lines.push('**Use this skill when asking about:**');
        for (const topic of skill.topics) {
            lines.push(`- ${topic}`);
        }
        lines.push('');
    }

    lines.push('## Example Questions');
    lines.push('');

    // Generate example routing
    for (const skill of subSkills.slice(0, 3)) {
        if (skill.topics.length > 0) {
            lines.push(`- "${skill.topics[0]}?" → Use **${skill.name}**`);
        }
    }

    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('*This is an auto-generated router skill. Install alongside the sub-skills listed above.*');

    return lines.join('\n');
}
