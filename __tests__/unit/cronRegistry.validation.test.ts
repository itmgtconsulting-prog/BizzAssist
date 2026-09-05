/**
 * BIZZ-2209: Drift guard for the canonical cron registry.
 *
 * Fails CI if the single-source-of-truth registry (app/lib/cron/registry.ts)
 * disagrees with vercel.json or the filesystem — the exact class of drift that
 * let a dead `verify-tenant-schemas` cron 404 daily and the cron inventory rot
 * across 4 divergent lists. Live DB-column validation for DATA_SOURCES happens
 * at runtime in the watchdog (checkAllDataFreshness config_error path).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CRON_JOBS, DATA_SOURCES } from '@/app/lib/cron/registry';

const ROOT = process.cwd();

interface VercelCron {
  path: string;
  schedule: string;
}
const vercelCrons: VercelCron[] = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')).crons;

// BIZZ-2221: pg_cron-schedulerede jobs ligger IKKE i vercel.json (de køres
// in-DB via migration). 'internal'-jobs drives in-process fra en anden cron
// (watchdog piggyback) og er heller ikke i vercel.json. Kun Vercel-schedulerede
// jobs indgår i bijektionen.
const vercelScheduledJobs = CRON_JOBS.filter(
  (c) => c.scheduler !== 'pgcron' && c.scheduler !== 'internal'
);

describe('cron registry ⇔ vercel.json', () => {
  it('is a bijection on path (every cron registered, no extras)', () => {
    const registryPaths = new Set(vercelScheduledJobs.map((c) => c.path));
    const vercelPaths = new Set(vercelCrons.map((c) => c.path));

    const missingFromRegistry = [...vercelPaths].filter((p) => !registryPaths.has(p));
    const missingFromVercel = [...registryPaths].filter((p) => !vercelPaths.has(p));

    expect(
      missingFromRegistry,
      `i vercel.json men ikke i registeret: ${missingFromRegistry}`
    ).toEqual([]);
    expect(missingFromVercel, `i registeret men ikke i vercel.json: ${missingFromVercel}`).toEqual(
      []
    );
  });

  it('schedules match vercel.json exactly', () => {
    const vercelByPath = new Map(vercelCrons.map((c) => [c.path, c.schedule]));
    for (const job of vercelScheduledJobs) {
      expect(job.schedule, `schedule-mismatch for ${job.jobName}`).toBe(vercelByPath.get(job.path));
    }
  });
});

describe('cron registry integrity', () => {
  it('has unique jobNames', () => {
    const names = CRON_JOBS.map((c) => c.jobName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every cron path resolves to a route.ts file', () => {
    for (const job of CRON_JOBS) {
      const rel = job.path.replace(/\?.*$/, '').replace(/^\//, '');
      const routeFile = join(ROOT, 'app', rel, 'route.ts');
      expect(existsSync(routeFile), `mangler route: ${routeFile}`).toBe(true);
    }
  });

  it('every dataSource link points to a registered source', () => {
    const sourceNames = new Set(DATA_SOURCES.map((s) => s.sourceName));
    for (const job of CRON_JOBS) {
      if (job.dataSource) {
        expect(
          sourceNames.has(job.dataSource),
          `${job.jobName} → ukendt dataSource '${job.dataSource}'`
        ).toBe(true);
      }
    }
  });
});

describe('data source registry integrity', () => {
  it('has unique sourceNames', () => {
    const names = DATA_SOURCES.map((s) => s.sourceName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every producedByJob references a registered cron', () => {
    const jobNames = new Set(CRON_JOBS.map((c) => c.jobName));
    for (const src of DATA_SOURCES) {
      if (src.producedByJob) {
        expect(
          jobNames.has(src.producedByJob),
          `${src.sourceName} → ukendt job '${src.producedByJob}'`
        ).toBe(true);
      }
    }
  });

  it('thresholds are sane (warning < critical)', () => {
    for (const src of DATA_SOURCES) {
      expect(src.warningHours, src.sourceName).toBeLessThan(src.criticalHours);
    }
  });
});
