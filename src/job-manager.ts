/**
 * Job Manager for handling async scraping operations
 * Uses Apify Key-Value Store for persistence
 */

import { Actor, log } from 'apify';
import { v4 as uuidv4 } from 'uuid';
import { Job, JobType, JobResult, SkillConfig } from './types.js';

// In-memory job cache (synced with KV Store)
const jobs: Map<string, Job> = new Map();

// Job execution queue
const jobQueue: string[] = [];
let isProcessing = false;
let maxConcurrentJobs = 3;

// Job handlers (set by main.ts)
type JobHandler = (job: Job, updateProgress: (progress: number, message: string) => Promise<void>) => Promise<JobResult>;
const jobHandlers: Map<JobType, JobHandler> = new Map();

/**
 * Initialize job manager with settings
 */
export function initJobManager(settings: { maxConcurrentJobs?: number }) {
    maxConcurrentJobs = settings.maxConcurrentJobs ?? 3;
    log.info(`Job manager initialized with maxConcurrentJobs: ${maxConcurrentJobs}`);
}

/**
 * Register a handler for a job type
 */
export function registerJobHandler(type: JobType, handler: JobHandler) {
    jobHandlers.set(type, handler);
    log.info(`Registered handler for job type: ${type}`);
}

/**
 * Create a new job and add to queue
 */
export async function createJob(type: JobType, config: SkillConfig): Promise<Job> {
    const jobId = `job-${uuidv4().substring(0, 8)}`;
    const now = new Date();

    const job: Job = {
        id: jobId,
        type,
        status: 'queued',
        progress: 0,
        message: 'Job queued, waiting to start...',
        config,
        createdAt: now,
        updatedAt: now,
    };

    // Store in memory and KV Store
    jobs.set(jobId, job);
    await persistJob(job);

    // Add to queue
    jobQueue.push(jobId);
    log.info(`Created job ${jobId} of type ${type}`);

    // Start processing if not already running
    processQueue();

    return job;
}

/**
 * Get job by ID
 */
export async function getJob(jobId: string): Promise<Job | null> {
    // Check memory first
    if (jobs.has(jobId)) {
        return jobs.get(jobId) ?? null;
    }

    // Try to load from KV Store
    const stored = await Actor.getValue<Job>(`job-${jobId}`);
    if (stored) {
        // Restore Date objects
        stored.createdAt = new Date(stored.createdAt);
        stored.updatedAt = new Date(stored.updatedAt);
        if (stored.completedAt) {
            stored.completedAt = new Date(stored.completedAt);
        }
        jobs.set(jobId, stored);
        return stored;
    }

    return null;
}

/**
 * Get all jobs
 */
export function getAllJobs(): Job[] {
    return Array.from(jobs.values()).sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
}

/**
 * Update job progress
 */
export async function updateJobProgress(jobId: string, progress: number, message: string): Promise<void> {
    const job = jobs.get(jobId);
    if (!job) return;

    job.progress = Math.min(100, Math.max(0, progress));
    job.message = message;
    job.updatedAt = new Date();

    await persistJob(job);
    log.info(`Job ${jobId}: ${progress}% - ${message}`);
}

/**
 * Complete job successfully
 */
export async function completeJob(jobId: string, result: JobResult): Promise<void> {
    const job = jobs.get(jobId);
    if (!job) return;

    job.status = 'completed';
    job.progress = 100;
    job.message = 'Job completed successfully';
    job.result = result;
    job.updatedAt = new Date();
    job.completedAt = new Date();

    await persistJob(job);
    log.info(`Job ${jobId} completed: ${result.pagesScraped} pages scraped`);
}

/**
 * Fail job with error
 */
export async function failJob(jobId: string, error: string): Promise<void> {
    const job = jobs.get(jobId);
    if (!job) return;

    job.status = 'failed';
    job.message = `Job failed: ${error}`;
    job.error = error;
    job.updatedAt = new Date();
    job.completedAt = new Date();

    await persistJob(job);
    log.error(`Job ${jobId} failed: ${error}`);
}

/**
 * Persist job to Apify Key-Value Store
 */
async function persistJob(job: Job): Promise<void> {
    try {
        await Actor.setValue(`job-${job.id}`, job);
    } catch (error) {
        log.warning(`Failed to persist job ${job.id}: ${error}`);
    }
}

/**
 * Process job queue
 */
async function processQueue(): Promise<void> {
    if (isProcessing) return;
    isProcessing = true;

    try {
        while (jobQueue.length > 0) {
            // Count running jobs
            const runningJobs = Array.from(jobs.values()).filter(
                (j) => j.status === 'running'
            ).length;

            if (runningJobs >= maxConcurrentJobs) {
                // Wait for a slot to open
                await new Promise((resolve) => setTimeout(resolve, 1000));
                continue;
            }

            // Get next job from queue
            const jobId = jobQueue.shift();
            if (!jobId) continue;

            const job = jobs.get(jobId);
            if (!job || job.status !== 'queued') continue;

            // Start job execution (don't await - run in background)
            executeJob(job);
        }
    } finally {
        isProcessing = false;
    }
}

/**
 * Execute a single job
 */
async function executeJob(job: Job): Promise<void> {
    const handler = jobHandlers.get(job.type);
    if (!handler) {
        await failJob(job.id, `No handler registered for job type: ${job.type}`);
        return;
    }

    // Update status to running
    job.status = 'running';
    job.message = 'Job started...';
    job.updatedAt = new Date();
    await persistJob(job);

    try {
        // Create progress update function
        const updateProgress = async (progress: number, message: string) => {
            await updateJobProgress(job.id, progress, message);
        };

        // Execute the handler
        const result = await handler(job, updateProgress);

        // Mark as completed
        await completeJob(job.id, result);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await failJob(job.id, errorMessage);
    }

    // Continue processing queue
    processQueue();
}

/**
 * Load existing jobs from KV Store on startup
 */
export async function loadExistingJobs(): Promise<void> {
    try {
        // List all keys starting with 'job-'
        const store = await Actor.openKeyValueStore();
        await store.forEachKey(async (key) => {
            if (key.startsWith('job-')) {
                const job = await Actor.getValue<Job>(key);
                if (job) {
                    // Restore Date objects
                    job.createdAt = new Date(job.createdAt);
                    job.updatedAt = new Date(job.updatedAt);
                    if (job.completedAt) {
                        job.completedAt = new Date(job.completedAt);
                    }
                    jobs.set(job.id, job);

                    // Re-queue jobs that were running when server stopped
                    if (job.status === 'running' || job.status === 'queued') {
                        job.status = 'queued';
                        job.message = 'Job re-queued after server restart';
                        jobQueue.push(job.id);
                    }
                }
            }
        });

        log.info(`Loaded ${jobs.size} existing jobs from storage`);

        // Resume processing if there are queued jobs
        if (jobQueue.length > 0) {
            processQueue();
        }
    } catch (error) {
        log.warning(`Failed to load existing jobs: ${error}`);
    }
}

/**
 * Clean up old completed jobs (older than 24 hours)
 */
export async function cleanupOldJobs(): Promise<void> {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago

    for (const [jobId, job] of jobs) {
        if (
            (job.status === 'completed' || job.status === 'failed') &&
            job.completedAt &&
            job.completedAt.getTime() < cutoff
        ) {
            jobs.delete(jobId);
            try {
                await Actor.setValue(`job-${jobId}`, null);
            } catch {
                // Ignore cleanup errors
            }
        }
    }
}
