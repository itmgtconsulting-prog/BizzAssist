#!/usr/bin/env node
/**
 * Adds the global "Blocked" status (id 10069) to the BIZZ project's workflow
 * ("Software workflow for project SCRUM") so it becomes usable as a transition
 * target on all BIZZ tickets.
 *
 * Strategy:
 *  1. Add Blocked as a status in the workflow, scoped to project 10000 (BIZZ).
 *  2. Add a GLOBAL transition id=51 → Blocked named "Blocked" so any ticket can
 *     transition to Blocked from any status.
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = 'bizzassist.atlassian.net';
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const auth = Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64');

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request(
      {
        hostname: HOST,
        path: p,
        method,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const WORKFLOW_ID = '1aa3f22a-4f68-4040-8676-ef61f374d861';
const VERSION_ID = '355c121e-796d-45e9-a4a6-616a63f9fa02';
const _PROJECT_ID = '10000';
const BLOCKED_STATUS_ID = '10069';

// Validate payload first
const validatePayload = {
  payload: {
    statuses: [
      // existing project-scoped ones — keep as-is
      {
        statusReference: '10000',
        name: 'To Do',
        statusCategory: 'TODO',
        description: '',
      },
      {
        statusReference: '10001',
        name: 'In Progress',
        statusCategory: 'IN_PROGRESS',
        description: 'This work item is being actively worked on at the moment by the assignee.',
      },
      {
        statusReference: '10002',
        name: 'In Review',
        statusCategory: 'IN_PROGRESS',
        description: '',
      },
      {
        statusReference: '10003',
        name: 'Done',
        statusCategory: 'DONE',
        description: '',
      },
      {
        statusReference: '10036',
        name: 'On Hold',
        statusCategory: 'IN_PROGRESS',
        description: 'Issue is blocked or waiting on external input/approval',
      },
      // NEW: Blocked
      {
        statusReference: BLOCKED_STATUS_ID,
        name: 'Blocked',
        statusCategory: 'IN_PROGRESS',
        description: 'Ticket cannot progress — blocked by external dependency or decision',
      },
    ],
    workflows: [
      {
        id: WORKFLOW_ID,
        version: { id: VERSION_ID, versionNumber: 1 },
        name: 'Software workflow for project SCRUM',
        description: '',
        startPointLayout: { x: 60.0, y: -70.0 },
        statuses: [
          { statusReference: '10000', layout: { x: 180.0, y: -16.0 }, properties: {}, deprecated: false },
          { statusReference: '10001', layout: { x: 324.47, y: -16.0 }, properties: {}, deprecated: false },
          { statusReference: '10002', layout: { x: 510.47, y: -16.0 }, properties: {}, deprecated: false },
          { statusReference: '10003', layout: { x: 682.4, y: -16.0 }, properties: {}, deprecated: false },
          { statusReference: '10036', layout: { x: 823.88, y: -43.0 }, properties: {}, deprecated: false },
          { statusReference: BLOCKED_STATUS_ID, layout: { x: 823.88, y: 40.0 }, properties: {}, deprecated: false },
        ],
        transitions: [
          { id: '1', type: 'INITIAL', toStatusReference: '10000', links: [], name: 'Create', description: '', actions: [], validators: [], triggers: [], properties: { 'jira.i18n.title': 'common.forms.create' } },
          { id: '2', type: 'GLOBAL', toStatusReference: '10036', links: [], name: 'On Hold', description: '', actions: [], validators: [], triggers: [], properties: {} },
          { id: '11', type: 'GLOBAL', toStatusReference: '10000', links: [], name: 'To Do', description: '', actions: [], validators: [], triggers: [], properties: { 'jira.i18n.title': 'gh.workflow.preset.todo' } },
          { id: '21', type: 'GLOBAL', toStatusReference: '10001', links: [], name: 'In Progress', description: '', actions: [], validators: [], triggers: [], properties: { 'jira.i18n.title': 'gh.workflow.preset.inprogress' } },
          { id: '31', type: 'GLOBAL', toStatusReference: '10002', links: [], name: 'In Review', description: '', actions: [], validators: [], triggers: [], properties: {} },
          { id: '41', type: 'GLOBAL', toStatusReference: '10003', links: [], name: 'Done', description: '', actions: [], validators: [], triggers: [], properties: { 'jira.i18n.title': 'gh.workflow.preset.done' } },
          // NEW transition to Blocked
          { id: '51', type: 'GLOBAL', toStatusReference: BLOCKED_STATUS_ID, links: [], name: 'Blocked', description: 'Mark ticket as blocked by external dependency', actions: [], validators: [], triggers: [], properties: {} },
        ],
        loopedTransitionContainerLayout: {},
      },
    ],
  },
};

console.log('→ Validate workflow update…');
const val = await req('POST', '/rest/api/3/workflows/update/validation', validatePayload);
console.log('  HTTP', val.status);
const valJson = JSON.parse(val.body);
if (valJson.errors?.length) {
  console.log('  Validation errors:');
  for (const e of valJson.errors) console.log('    -', e.errorMessage || JSON.stringify(e).slice(0, 200));
  process.exit(1);
}
console.log('  OK (no errors)');

console.log('\n→ Apply workflow update…');
const upd = await req('POST', '/rest/api/3/workflows/update', validatePayload.payload);
console.log('  HTTP', upd.status);
console.log(upd.body.slice(0, 800));
