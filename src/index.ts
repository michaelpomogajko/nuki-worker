import { Env, Hono } from 'hono';
import { DurableObject, env } from 'cloudflare:workers';
import { type } from 'arktype';
import { arktypeValidator } from '@hono/arktype-validator';

// Hono app for the Worker
const app = new Hono<{ Bindings: CloudflareBindings }>();

// Nuki API configuration
const NUKI_API_BASE = 'https://api.nuki.io';

const queryType = type({
	action: "'street' | 'floor' | 'both'"
});

type Action = typeof queryType.infer.action;


// Function to open a Nuki smart lock
async function openDoor(door: Action) {
	const doorId = {
		street: env.STREET_ID,
		floor: env.FLOOR_ID,
		both: undefined,
	}[door];

	if (!doorId) {
		throw new Error('Invalid door action');
	}

	try {
		const response = await fetch(`${NUKI_API_BASE}/smartlock/${doorId}/action/unlock`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${env.NUKI_API_KEY}`,
				'Content-Type': 'application/json',
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to open ${door.toUpperCase()}: ${response.statusText}`);
		}

		const message = `${door.toUpperCase()} unlocked successfully`;
		console.log(message);

		return { success: true, message };
	} catch (error: any) {
		const message = `Error opening ${door.toUpperCase()}: ${error.message}`;
		console.error(message);
		return { success: false, message };
	}
}

// Durable Object for delayed door opening
export class DoorOpener extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx = ctx;
	}

	async fetch(request: Request) {
		const url = new URL(request.url);
		const action = url.searchParams.get('action');

		if (action === 'both') {
			await this.ctx.storage.setAlarm(Date.now() + 50 * 1000);

			const message = 'Alarm scheduled for 2nd door';
			console.log(message);
			return new Response(JSON.stringify({ success: true, message }), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		return new Response(JSON.stringify({ success: false, message: 'Invalid action' }), {
			headers: { 'Content-Type': 'application/json' },
		});
	}

	async alarm() {
		await openDoor('floor');
	}
}

// Main Worker route handler
app.get('/open', arktypeValidator('query', queryType), async (c) => {
	const action = c.req.valid('query').action;

	if (c.req.header('Authorization') !== c.env.AUTH_KEY) {
		return c.json({ error: 'Invalid authorization' }, 401);
	}


	try {
		if (action !== 'both') {
			const result = await openDoor(action);
			return c.json(result);
		}

		const streetResult = await openDoor('street');
		if (!streetResult.success) {
			return c.json(streetResult, 500);
		}

		const id = c.env.DOOR_OPENER.idFromName('door-opener');
		const stub = c.env.DOOR_OPENER.get(id);
		const response = await stub.fetch(new Request(c.req.url));
		const floorResult = await response.json();

		return c.json({
			door1: streetResult,
			door2: floorResult,
		});
	} catch (error: any) {
		return c.json({ error: `Server error: ${error.message}` }, 500);
	}
});

app.onError((err, c) => {
	return c.json({ error: `Internal server error: ${err.message}` }, 500);
});

export default app;