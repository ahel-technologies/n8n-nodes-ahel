import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	AhelApiError,
	AhelClient,
	buildCallRequest,
	cleanDomain,
	coerceArguments,
	mapQuote,
	mapRun,
	rowArguments,
	runRows,
	type AhelRequest,
	type AhelResponse,
} from '../nodes/Ahel/client.js';

// ---------------------------------------------------------------- fakes

type Answer = AhelResponse | Error | ((request: AhelRequest) => AhelResponse);
const ok = (body: unknown, status = 200, headers: Record<string, unknown> = {}): AhelResponse => ({ status, headers, body });
const refused = (status: number, code: string, message: string, headers: Record<string, unknown> = {}) =>
	ok({ error: { code, message, retryable: false } }, status, headers);

/** A fake fetch: each route (method and path prefix) answers its list in order. */
function fakeFetch(routes: Record<string, Answer[]>) {
	const calls: AhelRequest[] = [];
	const fetch = async (request: AhelRequest): Promise<AhelResponse> => {
		calls.push(request);
		const path = request.url.replace(/^https?:\/\/[^/]+/, '');
		const key = Object.keys(routes)
			.filter((route) => {
				const [method, prefix] = route.split(' ');
				return method === request.method && path.startsWith(prefix);
			})
			.sort((a, b) => b.length - a.length)[0];
		const answer = key ? routes[key].shift() : undefined;
		if (!answer) throw new Error(`unexpected ${request.method} ${path}`);
		if (answer instanceof Error) throw answer;
		return typeof answer === 'function' ? answer(request) : answer;
	};
	return { fetch, calls };
}

function clientWith(routes: Record<string, Answer[]>) {
	const { fetch, calls } = fakeFetch(routes);
	let clock = 1_000_000;
	const slept: number[] = [];
	let keys = 0;
	const client = new AhelClient({
		baseUrl: 'https://ahel.test/',
		fetch,
		sleep: async (ms) => {
			slept.push(ms);
			clock += ms;
		},
		now: () => clock,
		minGapMs: 0,
		newKey: () => `key_${++keys}`,
	});
	return { client, calls, slept };
}

const query = (request: AhelRequest) => new URL(request.url).searchParams;

/** A finished people.email.find run as GET /api/v1/call answers it. */
const foundEmail = {
	execution_id: 'ex_1',
	capability_id: 'people.email.find',
	state: 'succeeded',
	rows: [{ data: { email: 'jane@example.com', confidence: 96 }, provenance: { endpoint_id: 'quickenrich.find' } }],
	routing: {
		served_by: 'quickenrich.find',
		tried: [
			{ endpoint_id: 'hunter.find', provider_name: 'Hunter', outcome: 'miss', charged_usd: '0' },
			{ endpoint_id: 'quickenrich.find', provider_name: 'QuickEnrich', outcome: 'hit', charged_usd: '0.004834' },
		],
		skipped: [],
		advice: null,
		verification: { verdict: 'valid', checked: true, served_by: 'ahel.verify', cost_usd: '0.0011' },
	},
	error: null,
	ledger: { charge_status: 'charged', charged_usd: '0.0064174', held_usd: '0' },
};

// ---------------------------------------------------------------- request building

describe('buildCallRequest', () => {
	it('puts the arguments, limits and headers on GET /api/v1/call/<id>', () => {
		const request = buildCallRequest(
			'https://ahel.ai/',
			'people.email.find',
			{ full_name: 'Jane Doe', domain: 'example.com', verify: true, skip: '', none: null },
			{ tag: 'acme-corp', maxCostUsd: 0.05, maxItems: 1, timeoutSeconds: 30 },
			'idem_1',
		);
		assert.equal(request.method, 'GET');
		assert.ok(request.url.startsWith('https://ahel.ai/api/v1/call/people.email.find?'));
		const params = query(request);
		assert.equal(params.get('full_name'), 'Jane Doe');
		assert.equal(params.get('domain'), 'example.com');
		assert.equal(params.get('verify'), 'true');
		assert.equal(params.has('skip'), false);
		assert.equal(params.has('none'), false);
		assert.equal(params.get('_max_items'), '1');
		assert.equal(params.get('_timeout_seconds'), '30');
		assert.equal(params.get('_raw'), '0');
		assert.deepEqual(request.headers, {
			accept: 'application/json',
			'Idempotency-Key': 'idem_1',
			'X-Ahel-Max-Cost': '0.05',
			'X-Ahel-Tag': 'acme-corp',
		});
		assert.equal(request.timeoutMs, 50_000);
	});

	it('repeats a list and sends an object as JSON', () => {
		const params = query(buildCallRequest('https://ahel.ai', 'x.search', { ids: ['a', 'b'], filter: { lang: 'en' } }, {}, 'k'));
		assert.deepEqual(params.getAll('ids'), ['a', 'b']);
		assert.equal(params.get('filter'), '{"lang":"en"}');
	});

	it('sends no cap or tag when none is set', () => {
		const request = buildCallRequest('https://ahel.ai', 'people.email.find', {}, { maxCostUsd: 0 }, 'k');
		assert.equal(request.headers['X-Ahel-Max-Cost'], undefined);
		assert.equal(request.headers['X-Ahel-Tag'], undefined);
	});

	it('refuses a bad id, a bad tag and a reserved argument before sending', () => {
		assert.throws(() => buildCallRequest('https://ahel.ai', 'not an id', {}, {}, 'k'), AhelApiError);
		assert.throws(() => buildCallRequest('https://ahel.ai', 'a.b', {}, { tag: 'Acme Corp' }, 'k'), /Tag "Acme Corp"/);
		assert.throws(() => buildCallRequest('https://ahel.ai', 'a.b', { _max_items: 5 }, {}, 'k'), /reserved/);
	});
});

describe('argument helpers', () => {
	it('cleans a website into a domain', () => {
		assert.equal(cleanDomain(' https://www.Example.com/about?x=1 '), 'example.com');
	});

	it('maps item fields to arguments', () => {
		const item = { Name: 'Jane Doe', domain: 'example.com', row_number: 4, empty: '' };
		assert.deepEqual(rowArguments(item, 'full_name=Name, domain'), { full_name: 'Jane Doe', domain: 'example.com' });
		assert.deepEqual(rowArguments(item, 'empty, missing'), {});
		assert.deepEqual(rowArguments(item, ''), item);
	});

	it('types string values by the input schema for a quote', () => {
		const schema = {
			properties: { verify: { type: 'boolean' }, limit: { type: 'integer' }, ids: { type: 'array' }, name: { type: 'string' } },
		};
		assert.deepEqual(coerceArguments({ verify: 'true', limit: '5', ids: 'a, b', name: '007', gone: '' }, schema), {
			verify: true,
			limit: 5,
			ids: ['a', 'b'],
			name: '007',
		});
	});
});

// ---------------------------------------------------------------- output mapping

describe('mapRun', () => {
	it('puts the answer fields next to cost_usd, provider and run_id', () => {
		assert.deepEqual(mapRun(foundEmail), {
			email: 'jane@example.com',
			confidence: 96,
			found: true,
			verification: 'valid',
			cost_usd: 0.0064174,
			charge_status: 'charged',
			provider: 'QuickEnrich',
			run_id: 'ex_1',
			task: 'people.email.find',
			state: 'succeeded',
		});
	});

	it('keeps every row under results when there are more than one', () => {
		const out = mapRun({ ...foundEmail, rows: [{ data: { name: 'A' } }, { data: { name: 'B' } }] });
		assert.equal(out.name, 'A');
		assert.deepEqual(out.results, [{ name: 'A' }, { name: 'B' }]);
	});

	it('answers a miss as found false and a released charge as 0', () => {
		const out = mapRun({
			execution_id: 'ex_2',
			state: 'succeeded',
			rows: [],
			routing: { served_by: null, tried: [] },
			ledger: { charge_status: 'released', charged_usd: '0' },
		});
		assert.equal(out.found, false);
		assert.equal(out.cost_usd, 0);
		assert.equal(out.provider, null);
	});

	it('shows the held amount while a run is still pending', () => {
		const out = mapRun({ execution_id: 'ex_3', state: 'running', ledger: { charge_status: 'pending', held_usd: '0.0396374' } });
		assert.equal(out.cost_usd, 0.0396374);
		assert.equal(out.charge_status, 'pending');
	});
});

describe('mapQuote', () => {
	it('answers the most the run can reserve and the providers in order', () => {
		const out = mapQuote('people.email.find', {
			quote_id: 'q_1',
			expires_at: '2026-11-03T12:00:00Z',
			customer_total_usd: '0.0396374',
			components: { provider_estimate_usd: '0.036034', platform_fee_usd: '0.0036034' },
			attempt_plan: [
				{ endpoint_id: 'quickenrich.find', provider_id: 'quickenrich', max_cost_usd: '0.0053174' },
				{ endpoint_id: 'hunter.find', provider_id: 'hunter', max_cost_usd: '0.01012' },
			],
			reserve_note: 'price from $0.0053174',
			authorisable: true,
			blocked_reason: null,
			ledger: { available_usd: '0.98' },
		});
		assert.equal(out.quote_only, true);
		assert.equal(out.cost_usd, 0.0396374);
		assert.equal(out.provider, 'quickenrich');
		assert.deepEqual(out.attempt_plan, [
			{ provider: 'quickenrich', endpoint_id: 'quickenrich.find', max_cost_usd: 0.0053174 },
			{ provider: 'hunter', endpoint_id: 'hunter.find', max_cost_usd: 0.01012 },
		]);
		assert.equal(out.available_usd, 0.98);
		assert.equal(out.run_id, null);
	});
});

// ---------------------------------------------------------------- client against a fake fetch

describe('AhelClient.run', () => {
	it('runs once and maps the answer', async () => {
		const { client, calls } = clientWith({ 'GET /api/v1/call/': [ok(foundEmail)] });
		const out = await client.run('people.email.find', { full_name: 'Jane Doe', domain: 'example.com', verify: true }, { tag: 'n8n' });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].headers['Idempotency-Key'], 'key_1');
		assert.equal(calls[0].url.split('?')[0], 'https://ahel.test/api/v1/call/people.email.find');
		assert.equal(out.email, 'jane@example.com');
		assert.equal(out.cost_usd, 0.0064174);
		assert.equal(out.provider, 'QuickEnrich');
	});

	it('reads a run that answered 202 until it settles, then its rows', async () => {
		const { client, calls } = clientWith({
			'GET /api/v1/call/': [ok({ execution_id: 'ex_9', state: 'running', rows: [], ledger: { charge_status: 'pending', held_usd: '0.01' } }, 202)],
			'GET /api/platform/v2/runs/ex_9': [
				ok({ execution_id: 'ex_9', state: 'running', ledger: { charge_status: 'pending', held_usd: '0.01' } }),
				ok({
					execution_id: 'ex_9',
					capability_id: 'companies.register.search',
					state: 'succeeded',
					routing: { served_by: 'ahel.registry', tried: [{ endpoint_id: 'ahel.registry', provider_name: 'Ahel registry' }] },
					ledger: { charge_status: 'charged', charged_usd: '0.004' },
				}),
			],
			'GET /api/platform/v2/runs/ex_9/results': [ok({ rows: [{ data: { name: 'Bolt Technology OÜ', registry_code: '12417834' } }] })],
		});
		const out = await client.run('companies.register.search', { name: 'Bolt', country: 'EE' });
		assert.deepEqual(
			calls.map((c) => c.url.replace('https://ahel.test', '').split('?')[0]),
			['/api/v1/call/companies.register.search', '/api/platform/v2/runs/ex_9', '/api/platform/v2/runs/ex_9', '/api/platform/v2/runs/ex_9/results'],
		);
		assert.equal(out.registry_code, '12417834');
		assert.equal(out.cost_usd, 0.004);
		assert.equal(out.provider, 'Ahel registry');
	});

	it('waits Retry-After on 429 rate_limited and sends the same run again', async () => {
		const { client, calls, slept } = clientWith({
			'GET /api/v1/call/': [refused(429, 'rate_limited', 'Slow down.', { 'retry-after': '3' }), ok(foundEmail)],
		});
		const out = await client.run('people.email.find', { full_name: 'Jane Doe', domain: 'example.com' });
		assert.equal(out.run_id, 'ex_1');
		assert.ok(slept.includes(3000));
		assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
	});

	it('retries a network failure with the same Idempotency-Key', async () => {
		const { client, calls } = clientWith({ 'GET /api/v1/call/': [new Error('socket hang up'), ok(foundEmail)] });
		await client.run('people.email.find', { full_name: 'Jane Doe', domain: 'example.com' });
		assert.equal(calls.length, 2);
		assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
	});

	it("throws the API's own message and code on a refusal", async () => {
		const { client } = clientWith({
			'GET /api/v1/call/': [refused(402, 'max_cost_exceeded', 'This run is quoted at $0.0396374, above X-Ahel-Max-Cost $0.01. Nothing was held or run.')],
		});
		await assert.rejects(client.run('people.email.find', { full_name: 'Jane Doe', domain: 'example.com' }, { maxCostUsd: 0.01 }), (error: unknown) => {
			assert.ok(error instanceof AhelApiError);
			assert.equal(error.status, 402);
			assert.equal(error.code, 'max_cost_exceeded');
			assert.match(error.message, /above X-Ahel-Max-Cost \$0\.01/);
			return true;
		});
	});

	it('runChecked throws when the run failed outright', async () => {
		const { client } = clientWith({
			'GET /api/v1/call/': [
				ok({
					execution_id: 'ex_5',
					state: 'failed',
					rows: [],
					error: { code: 'provider_unavailable', message: 'Every provider failed.' },
					ledger: { charge_status: 'released', charged_usd: '0' },
				}),
			],
		});
		await assert.rejects(client.runChecked('people.email.find', { full_name: 'Jane Doe', domain: 'example.com' }), /Every provider failed\. \(nothing charged\)/);
	});
});

describe('AhelClient.quote', () => {
	const capabilities = ok({
		service: { registry_revision: 'rev_1' },
		capabilities: [{ capability_id: 'people.email.find', inputs: { properties: { verify: { type: 'boolean' } } }, endpoints: [{ endpoint_id: 'hunter.find' }] }],
	});
	const quote = ok({ quote_id: 'q_1', customer_total_usd: '0.0396374', attempt_plan: [{ provider_id: 'quickenrich', endpoint_id: 'quickenrich.find' }], ledger: {} });

	it('resolves a task id through the catalog and posts typed arguments', async () => {
		const { client, calls } = clientWith({
			'GET /api/platform/v2/capabilities': [capabilities],
			'GET /api/platform/v2/catalog/': [ok({ id: 'find-work-email', kind: 'task', capability_ids: ['people.email.find'], bound_endpoint_ids: [] })],
			'POST /api/platform/v2/quotes': [quote],
		});
		const out = await client.quote('find-work-email', { full_name: 'Jane Doe', verify: 'true' });
		const posted = calls.find((c) => c.method === 'POST');
		assert.deepEqual(posted?.body, {
			capability_id: 'people.email.find',
			registry_revision: 'rev_1',
			arguments: { full_name: 'Jane Doe', verify: true },
			limits: { max_items: 1, timeout_seconds: 60 },
		});
		assert.equal(out.cost_usd, 0.0396374);
		assert.equal(out.task, 'find-work-email');
	});

	it('reloads the registry once when it changed', async () => {
		const { client, calls } = clientWith({
			'GET /api/platform/v2/capabilities': [capabilities, ok({ service: { registry_revision: 'rev_2' }, capabilities: [{ capability_id: 'people.email.find' }] })],
			'POST /api/platform/v2/quotes': [refused(409, 'registry_changed', 'The registry changed.'), quote],
		});
		await client.quote('people.email.find', { full_name: 'Jane Doe' });
		const posts = calls.filter((c) => c.method === 'POST');
		assert.deepEqual(posts.map((c) => c.body?.registry_revision), ['rev_1', 'rev_2']);
	});
});

describe('AhelClient.search', () => {
	it('answers catalog hits as dropdown entries', async () => {
		const { client, calls } = clientWith({
			'GET /api/platform/v2/catalog': [
				ok({
					items: [
						{ id: 'people.email.find', label: 'Find work email', status: 'ready', price_from: '$0.0053174', summary: 'A work email', web_path: '/catalog/people.email.find' },
						{ id: 'x.posts', label: 'X posts', status: 'coming_soon', status_label: 'Coming soon', price_from: null, summary: null, web_path: null },
					],
				}),
			],
		});
		const hits = await client.search('email');
		assert.equal(query(calls[0]).get('q'), 'email');
		assert.deepEqual(hits, [
			{ name: 'Find work email (people.email.find)', value: 'people.email.find', description: 'A work email · from $0.0053174', url: 'https://ahel.test/catalog/people.email.find' },
			{ name: 'X posts (x.posts) · Coming soon', value: 'x.posts' },
		]);
	});
});

describe('runRows', () => {
	it('keeps every row in order with its own cost, and a refused row with its error', async () => {
		const { client } = clientWith({
			'GET /api/v1/call/': [
				(request) => {
					const name = query(request).get('full_name');
					if (name === 'No Money') return refused(402, 'insufficient_balance', 'Top up to run this.');
					return ok({ ...foundEmail, execution_id: `ex_${name}`, rows: [{ data: { email: `${name}@example.com` } }] });
				},
				(request) => ok({ ...foundEmail, execution_id: `ex_${query(request).get('full_name')}`, rows: [], ledger: { charge_status: 'not_charged', charged_usd: '0' } }),
				(request) => {
					const name = query(request).get('full_name');
					if (name === 'No Money') return refused(402, 'insufficient_balance', 'Top up to run this.');
					return ok({ ...foundEmail, execution_id: `ex_${name}` });
				},
			],
		});
		const input = [
			{ Name: 'Ann', row_number: 2 },
			{ Name: 'Bob', row_number: 3 },
			{ Name: 'No Money', row_number: 4 },
		];
		const { rows, errors } = await runRows(
			client,
			input.length,
			(i) => ({ taskId: 'people.email.find', args: { full_name: input[i].Name, domain: 'example.com' }, options: {}, base: { ...input[i] } }),
			1,
		);
		assert.equal(rows.length, 3);
		assert.equal(rows[0].row_number, 2);
		assert.equal(rows[0].email, 'Ann@example.com');
		assert.equal(rows[0].cost_usd, 0.0064174);
		assert.equal(rows[0].run_id, 'ex_Ann');
		assert.equal(rows[1].found, false);
		assert.equal(rows[1].cost_usd, 0);
		assert.equal(rows[2].row_number, 4);
		assert.equal(rows[2].error, 'Top up to run this.');
		assert.equal(rows[2].error_code, 'insufficient_balance');
		assert.equal(rows[2].cost_usd, 0);
		assert.deepEqual(errors.map((e) => e.index), [2]);
	});

	it('records a row whose parameters cannot be read', async () => {
		const { client } = clientWith({});
		const { rows, errors } = await runRows(client, 1, () => {
			throw new AhelApiError('Arguments must be a JSON object.', 422, 'invalid_arguments');
		});
		assert.equal(rows[0].error_code, 'invalid_arguments');
		assert.equal(errors.length, 1);
	});
});
