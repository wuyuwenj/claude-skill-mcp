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

/**
 * Register all MCP tools
 */
export function registerTools(server: McpServer): void {
    // Tool 1: Generate Config
    server.registerTool(
        'generate_config',
        {
            description:
                'Generate a configuration for scraping documentation. Returns a config object that can be used with scrape_docs.',
            inputSchema: {
                name: z.string().describe('Skill name (lowercase, alphanumeric, hyphens)'),
                url: z.string().url().describe('Base documentation URL'),
                description: z.string().describe('Description of when to use this skill'),
                maxPages: z.number().optional().default(100).describe('Maximum pages to scrape'),
                rateLimit: z.number().optional().default(0.5).describe('Delay between requests in seconds'),
            },
        },
        async ({ name, url, description, maxPages, rateLimit }): Promise<CallToolResult> => {
            log.info(`Generating config for: ${name}`);

            const config: SkillConfig = {
                name: name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                description,
                baseUrl: url,
                maxPages,
                rateLimit,
                selectors: {
                    mainContent: 'article',
                    title: 'h1',
                    codeBlocks: 'pre code',
                },
                urlPatterns: {
                    include: [],
                    exclude: ['**/login**', '**/signup**', '**/*.pdf', '**/*.zip'],
                },
            };

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                success: true,
                                config,
                                message: `Config generated for ${name}. Use scrape_docs tool with this config to start scraping.`,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    // Tool 2: Estimate Pages
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

    log.info('Registered 10 MCP tools');
}
