/**
 * Skill Seekers MCP Server
 * Main entry point - Express server with MCP endpoint
 */

import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';
import { log, Actor } from 'apify';

import { registerTools } from './tools.js';
import {
    initJobManager,
    registerJobHandler,
    loadExistingJobs,
    cleanupOldJobs,
    getJob,
} from './job-manager.js';
import { scrapeDocumentation } from './scrapers/doc-scraper.js';
import { scrapeGitHub } from './scrapers/github-scraper.js';
import { scrapePdf } from './scrapers/pdf-scraper.js';
import { ActorInput } from './types.js';

// Initialize the Apify Actor environment
await Actor.init();

// Read Actor input
const input = (await Actor.getInput<ActorInput>()) ?? {};
const { githubToken, maxConcurrentJobs = 3, defaultMaxPages = 100 } = input;

// Store GitHub token for scrapers
if (githubToken) {
    process.env.GITHUB_TOKEN = githubToken;
}

// Initialize job manager
initJobManager({ maxConcurrentJobs });

// Register job handlers
registerJobHandler('scrape_docs', scrapeDocumentation);
registerJobHandler('scrape_github', scrapeGitHub);
registerJobHandler('scrape_pdf', scrapePdf);

// Load existing jobs from KV Store
await loadExistingJobs();

// Periodic cleanup of old jobs
setInterval(() => cleanupOldJobs(), 60 * 60 * 1000); // Every hour

/**
 * Create MCP server instance
 */
function getServer(): McpServer {
    const server = new McpServer(
        {
            name: 'skill-seekers-mcp',
            version: '1.0.0',
        },
        { capabilities: { logging: {} } }
    );

    // Register all tools
    registerTools(server);

    // Register server info resource
    server.registerResource(
        'server-info',
        'https://skill-seekers.apify.actor/info',
        { mimeType: 'text/plain' },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'https://skill-seekers.apify.actor/info',
                        text: `Skill Seekers MCP Server v1.0.0

Create Claude AI skills from documentation, GitHub repos, and PDFs.

Available Tools:
- generate_config: Create a scraping configuration
- estimate_pages: Preview page count before scraping
- scrape_docs: Start documentation scraping job
- scrape_github: Start GitHub repository scraping job
- scrape_pdf: Start PDF extraction job
- get_job_status: Check job progress
- list_jobs: List all jobs
- list_skills: List generated skills
- get_skill: Get skill download URL
- list_configs: List preset configurations

Workflow:
1. Use generate_config or list_configs to get a configuration
2. Use scrape_* to start a job (returns job ID)
3. Use get_job_status to poll for completion
4. Use get_skill to download the generated skill

Settings:
- Max concurrent jobs: ${maxConcurrentJobs}
- Default max pages: ${defaultMaxPages}
- GitHub token: ${githubToken ? 'configured' : 'not configured'}`,
                    },
                ],
            };
        }
    );

    return server;
}

// Create Express app
const app = express();
app.use(express.json());

// Configure CORS
app.use(
    cors({
        origin: '*',
        exposedHeaders: ['Mcp-Session-Id'],
    })
);

// Status endpoint
app.get('/', (req: Request, res: Response) => {
    // Handle Apify readiness probe
    if (req.headers['x-apify-container-server-readiness-probe']) {
        log.info('Readiness probe');
        res.end('ok\n');
        return;
    }

    // Build MCP endpoint URL
    const webServerUrl = process.env.ACTOR_WEB_SERVER_URL;
    const mcpUrl = webServerUrl ? `${webServerUrl}/mcp` : 'http://localhost:3000/mcp';

    // Generate CLI command
    const cliCommand = `claude mcp add --transport http skill-seekers ${mcpUrl} --header "Authorization: Bearer YOUR_APIFY_TOKEN"`;

    res.json({
        status: 'running',
        name: 'skill-seekers-mcp',
        version: '1.0.0',
        description: 'Create Claude AI skills from documentation, GitHub repos, and PDFs',
        tools: [
            'generate_config',
            'estimate_pages',
            'scrape_docs',
            'scrape_github',
            'scrape_pdf',
            'get_job_status',
            'list_jobs',
            'list_skills',
            'get_skill',
            'list_configs',
        ],
        mcp_endpoint: mcpUrl,
        cli_command: cliCommand,
        settings: {
            maxConcurrentJobs,
            defaultMaxPages,
            githubTokenConfigured: !!githubToken,
        },
        setup_instructions: {
            step1: 'Get your Apify API token from https://console.apify.com/account/integrations',
            step2: 'Copy and run the command above, replacing YOUR_APIFY_TOKEN with your actual token',
            step3: 'Restart Claude Code to load the new MCP server',
        },
        usage_example: {
            step1: 'Use generate_config to create a config for your docs',
            step2: 'Use scrape_docs with the config to start scraping',
            step3: 'Use get_job_status to check progress',
            step4: 'Use get_skill to download the generated skill',
        },
    });
});

// MCP endpoint
app.post('/mcp', async (req: Request, res: Response) => {
    const server = getServer();

    try {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);

        res.on('close', () => {
            log.info('Request closed');
            transport.close();
            server.close();
        });
    } catch (error) {
        log.error('Error handling MCP request:', { error });

        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: 'Internal server error',
                },
                id: null,
            });
        }
    }
});

// Method not allowed for GET/DELETE on /mcp
app.get('/mcp', (_req: Request, res: Response) => {
    log.info('Received GET MCP request');
    res.status(405).json({
        jsonrpc: '2.0',
        error: {
            code: -32000,
            message: 'Method not allowed. Use POST.',
        },
        id: null,
    });
});

app.delete('/mcp', (_req: Request, res: Response) => {
    log.info('Received DELETE MCP request');
    res.status(405).json({
        jsonrpc: '2.0',
        error: {
            code: -32000,
            message: 'Method not allowed.',
        },
        id: null,
    });
});

// Job status endpoint (REST API fallback)
app.get('/jobs/:jobId', async (req: Request, res: Response) => {
    const { jobId } = req.params;
    const job = await getJob(jobId);

    if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
    }

    res.json({
        id: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        message: job.message,
        result: job.result,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        completedAt: job.completedAt,
    });
});

// Start the server
const PORT = process.env.ACTOR_WEB_SERVER_PORT ? parseInt(process.env.ACTOR_WEB_SERVER_PORT) : 3000;

app.listen(PORT, (error) => {
    if (error) {
        log.error('Failed to start server:', { error });
        process.exit(1);
    }

    log.info(`Skill Seekers MCP Server listening on port ${PORT}`);
    log.info(`Settings: maxConcurrentJobs=${maxConcurrentJobs}, defaultMaxPages=${defaultMaxPages}`);

    // Output CLI command
    const webServerUrl = process.env.ACTOR_WEB_SERVER_URL;
    const mcpUrl = webServerUrl ? `${webServerUrl}/mcp` : `http://localhost:${PORT}/mcp`;

    log.info('='.repeat(80));
    log.info('To add this MCP server to Claude Code, run:');
    log.info(
        `claude mcp add --transport http skill-seekers ${mcpUrl} --header "Authorization: Bearer YOUR_APIFY_TOKEN"`
    );
    log.info('Replace YOUR_APIFY_TOKEN with your token from: https://console.apify.com/account/integrations');
    log.info('='.repeat(80));
});

// Handle shutdown
process.on('SIGINT', async () => {
    log.info('Shutting down server...');
    await Actor.exit();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log.info('Received SIGTERM, shutting down...');
    await Actor.exit();
    process.exit(0);
});
