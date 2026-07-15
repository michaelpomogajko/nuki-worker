import { Hono } from 'hono';
import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import { type } from 'arktype';
import { arktypeValidator } from '@hono/arktype-validator';

const app = new Hono<{ Bindings: CloudflareBindings }>();

const NUKI_API_BASE = 'https://api.nuki.io';
const FLOOR_OPEN_DELAY = '50 seconds';
const OPEN_STEP_CONFIG = {
	retries: {
		limit: 1,
		// Nuki returns 423 Locked while the lock is still executing a previous
		// command; a short retry lands inside that busy window
		delay: '20 seconds',
		backoff: 'linear',
	},
} satisfies WorkflowStepConfig;
const DEDUPE_WINDOW_MS = 60_000;
const ACTIVE_STATUSES: InstanceStatus['status'][] = ['queued', 'running', 'paused', 'waiting', 'waitingForPause'];

const queryType = type({
	action: "'street' | 'floor' | 'both'"
});

type Action = typeof queryType.infer.action;
type Door = Exclude<Action, 'both'>;
type DoorOpenWorkflowParams = {
	action: Action;
};
type DoorOpenResult = {
	success: true;
	door: Door;
	message: string;
};
type DoorOpenWorkflowResult =
	| {
		action: Door;
		door: DoorOpenResult;
	}
	| {
		action: 'both';
		door1: DoorOpenResult;
		door2: DoorOpenResult;
	};

function getDoorId(door: Door, bindings: CloudflareBindings) {
	const doorId = {
		street: bindings.STREET_ID,
		floor: bindings.FLOOR_ID,
	}[door];

	if (!doorId) {
		throw new Error('Invalid door action');
	}

	return doorId;
}

async function openDoor(door: Door, bindings: CloudflareBindings): Promise<DoorOpenResult> {
	const doorId = getDoorId(door, bindings);
	const response = await fetch(`${NUKI_API_BASE}/smartlock/${doorId}/action/unlock`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${bindings.NUKI_API_KEY}`,
			'Content-Type': 'application/json',
		},
	});

	if (!response.ok) {
		const details = await response.text().catch(() => '');
		const suffix = details ? `: ${details}` : '';
		throw new Error(`Failed to open ${door.toUpperCase()}: ${response.status} ${response.statusText}${suffix}`);
	}

	const message = `${door.toUpperCase()} unlocked successfully`;
	console.log(message);

	return { success: true, door, message };
}

export class DoorOpenWorkflow extends WorkflowEntrypoint<CloudflareBindings, DoorOpenWorkflowParams> {
	async run(event: WorkflowEvent<DoorOpenWorkflowParams>, step: WorkflowStep): Promise<DoorOpenWorkflowResult> {
		const { action } = event.payload;

		if (action === 'both') {
			const door1 = await step.do('open street door', OPEN_STEP_CONFIG, () => openDoor('street', this.env));
			await step.sleep('wait before floor door', FLOOR_OPEN_DELAY);
			const door2 = await step.do('open floor door', OPEN_STEP_CONFIG, () => openDoor('floor', this.env));

			return { action, door1, door2 };
		}

		const door = await step.do(`open ${action} door`, OPEN_STEP_CONFIG, () => openDoor(action, this.env));
		return { action, door };
	}
}

app.get('/open', arktypeValidator('query', queryType), async (c) => {
	const action = c.req.valid('query').action;

	if (c.req.header('Authorization') !== c.env.AUTH_KEY) {
		return c.json({ error: 'Invalid authorization' }, 401);
	}

	// A duplicate trigger while a run is in flight makes Nuki reject the second
	// unlock with 423 Locked, so runs within the same window share one instance id
	const dedupeId = `${action}-${Math.floor(Date.now() / DEDUPE_WINDOW_MS)}`;

	try {
		let instance;
		try {
			instance = await c.env.DOOR_OPEN_WORKFLOW.create({
				id: dedupeId,
				params: { action },
			});
		} catch {
			const existing = await c.env.DOOR_OPEN_WORKFLOW.get(dedupeId).catch(() => null);
			const existingStatus = existing && await existing.status();

			if (existingStatus && ACTIVE_STATUSES.includes(existingStatus.status)) {
				return c.json({
					success: true,
					deduped: true,
					message: `Door opening already in progress for ${action.toUpperCase()}`,
					instanceId: dedupeId,
					status: existingStatus,
				}, 200);
			}

			// id is taken by a finished run from earlier in this window
			instance = await c.env.DOOR_OPEN_WORKFLOW.create({
				params: { action },
			});
		}

		return c.json({
			success: true,
			message: `Door opening workflow started for ${action.toUpperCase()}`,
			instanceId: instance.id,
			status: await instance.status(),
		}, 202);
	} catch (error: any) {
		return c.json({ error: `Server error: ${error.message}` }, 500);
	}
});

app.get('/open/:instanceId', async (c) => {
	if (c.req.header('Authorization') !== c.env.AUTH_KEY) {
		return c.json({ error: 'Invalid authorization' }, 401);
	}

	try {
		const instanceId = c.req.param('instanceId');
		const instance = await c.env.DOOR_OPEN_WORKFLOW.get(instanceId);

		return c.json({
			instanceId,
			status: await instance.status(),
		});
	} catch (error: any) {
		return c.json({ error: `Workflow lookup failed: ${error.message}` }, 404);
	}
});

app.onError((err, c) => {
	return c.json({ error: `Internal server error: ${err.message}` }, 500);
});

export default app;
