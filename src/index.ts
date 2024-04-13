
export interface Env {
	TIMEOUT: DurableObjectNamespace;

	STREET_ID: string;
	FLOOR_ID: string;
	NUKI_API_KEY: string;
	AUTH_KEY: string;
}

type Device = 'floor' | 'street';

const TIMEOUT = 50;

const deviceUrl = (device: Device, env: Env) => {
	const id = device === 'floor' ? env.FLOOR_ID : env.STREET_ID;
	return `https://api.nuki.io/smartlock/${id}/action/unlock`
}

const openDoor = async (door: Device, env: Env) => {
	if (door !== 'floor' && door !== 'street') {
		console.error(`Door ${door} not found`)
		return new Response('Bad request', { status: 400 })
	}

	const url = deviceUrl(door, env);

	const res = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.NUKI_API_KEY}`,
			'Content-Type': 'application/json'
		}
	})

	if (res.ok) {
		console.log(`Opening ${door}`, new Date().toLocaleString('de'))
	} else {
		console.error(res.status, res.statusText)
	}

	return res;
}

export class TimeoutObject {

	state: DurableObjectState;
	storage: DurableObjectStorage;
	env: Env;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.storage = state.storage
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		let currentAlarm = await this.storage.getAlarm();

		if (currentAlarm) {
			console.error('timer already set');
			return new Response('Timer already set', { status: 400 })
		}

		const timeout = new URL(request.url).searchParams.get('timeout');
		const customTimeout = Number(timeout);
		const seconds = customTimeout? customTimeout: TIMEOUT;

		this.storage.setAlarm(Date.now() + seconds * 1000);
		console.log(`timer set to ${seconds} seconds`);
		return new Response(`${seconds}`, { status: 200 })

	}

	async alarm() {
		await openDoor('floor', this.env)
		this.storage.deleteAlarm();
	}

}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== 'GET') {
			return new Response('Bad request', { status: 400 })
		}
		const auth = request.headers.get('Authorization');

		if (auth !== env.AUTH_KEY) {
			return new Response('Unauthorized', { status: 401 })
		}

		const door = url.searchParams.get('door') as Device | null;

		if (door) {
			const res = await openDoor(door, env)
			if (!res.ok) {
				return new Response('Error', { status: 500 })
			}

			return new Response('ok');
		}

		// opening both
		const res = await openDoor('street', env);
		if (!res.ok) return new Response('Error', { status: 500 })

		// set durable object
		let id: DurableObjectId = env.TIMEOUT.idFromName(new URL(request.url).pathname);
		return env.TIMEOUT.get(id).fetch(request);
	},
};
