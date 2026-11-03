import type { IDataObject } from 'n8n-workflow';

// Ahel's public HTTP API, as the node uses it:
//
//   GET  /api/v1/call/<task or capability id>?arg=value   quote, hold, run, wait, settle
//   GET  /api/platform/v2/runs/<run id>                    a run that was still going (202)
//   GET  /api/platform/v2/runs/<run id>/results?raw=0      its rows
//   GET  /api/platform/v2/capabilities                     registry revision, input schemas
//   GET  /api/platform/v2/catalog?q=                       catalog search (the task dropdown)
//   GET  /api/platform/v2/catalog/<id>                     one task: its capability
//   POST /api/platform/v2/quotes                           the exact price, nothing held or run
//
// Every request carries the team API key in X-Ahel-Token (the credential adds it).
// Nothing is priced here: every amount is the API's own.

export const DEFAULT_BASE_URL = 'https://ahel.ai';

export interface AhelRequest {
	method: 'GET' | 'POST';
	url: string;
	headers: Record<string, string>;
	body?: IDataObject;
	timeoutMs: number;
}

export interface AhelResponse {
	status: number;
	headers: Record<string, unknown>;
	body: unknown;
}

/** Sends one request and answers whatever came back, any status. Throws only
 *  when no answer arrived (a network error or a timeout). */
export type AhelFetch = (request: AhelRequest) => Promise<AhelResponse>;

export class AhelApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
		readonly runId: string | null = null,
	) {
		super(message);
		this.name = 'AhelApiError';
	}
}

export interface ClientOptions {
	baseUrl?: string;
	fetch: AhelFetch;
	sleep: (ms: number) => Promise<void>;
	now?: () => number;
	/** Least time between two requests. The workspace allows 30 a minute. */
	minGapMs?: number;
	/** A fresh Idempotency-Key per run. */
	newKey: () => string;
}

export interface RunOptions {
	tag?: string;
	/** USD; the run is refused (402, nothing held) when quoted above it. */
	maxCostUsd?: number;
	maxItems?: number;
	timeoutSeconds?: number;
}

const SETTLED = new Set(['charged', 'released', 'not_charged']);
const TERMINAL = new Set([
	'succeeded',
	'partial',
	'failed',
	'outcome_unknown',
	'cancelled',
	'timed_out',
	'released',
	'expired',
]);
const FAILED = new Set(['failed', 'outcome_unknown', 'cancelled', 'timed_out', 'expired']);
const RESERVED = new Set(['_max_items', '_timeout_seconds', '_raw']);
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TAG = /^[a-z0-9._-]{1,64}$/;
const POLL_MS = 1_000;
const NETWORK_TRIES = 3;
const RATE_LIMIT_TRIES = 5;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function normaliseBaseUrl(url: string | undefined): string {
	const trimmed = (url ?? '').trim().replace(/\/+$/, '');
	return trimmed || DEFAULT_BASE_URL;
}

/** "https://www.Acme.com/about" -> "acme.com". */
export function cleanDomain(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^[a-z]+:\/\//, '')
		.replace(/^www\./, '')
		.replace(/[/?#].*$/, '');
}

/** One argument as query values: lists repeat the key, objects go as JSON. */
function queryValues(value: unknown): string[] {
	if (value === undefined || value === null || value === '') return [];
	if (Array.isArray(value)) return value.flatMap((entry) => queryValues(entry));
	if (typeof value === 'object') return [JSON.stringify(value)];
	return [String(value)];
}

export function queryString(params: Record<string, unknown>): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(params)) {
		for (const entry of queryValues(value)) {
			parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(entry)}`);
		}
	}
	return parts.join('&');
}

/** "0.05" from a number of dollars, at most 12 places, as X-Ahel-Max-Cost takes it. */
export function usdHeader(usd: number): string {
	return usd
		.toFixed(12)
		.replace(/0+$/, '')
		.replace(/\.$/, '');
}

export function checkId(id: string): string {
	const trimmed = id.trim();
	if (!ID.test(trimmed)) {
		throw new AhelApiError(
			`"${id}" is not a task id. Pick a task from the list or type an id such as people.email.find.`,
			422,
			'invalid_arguments',
		);
	}
	return trimmed;
}

/** GET /api/v1/call/<id>: the request for one run, nothing sent yet. */
export function buildCallRequest(
	baseUrl: string,
	id: string,
	args: Record<string, unknown>,
	options: RunOptions,
	idempotencyKey: string,
): AhelRequest {
	const taskId = checkId(id);
	const clash = Object.keys(args).find((key) => RESERVED.has(key));
	if (clash) throw new AhelApiError(`"${clash}" is reserved; set it under Options.`, 422, 'invalid_arguments');
	const timeoutSeconds = options.timeoutSeconds ?? 60;
	const query = queryString({
		...args,
		_max_items: options.maxItems ?? 1,
		_timeout_seconds: timeoutSeconds,
		_raw: 0,
	});
	const headers: Record<string, string> = {
		accept: 'application/json',
		'Idempotency-Key': idempotencyKey,
	};
	if (options.maxCostUsd !== undefined && options.maxCostUsd > 0) {
		headers['X-Ahel-Max-Cost'] = usdHeader(options.maxCostUsd);
	}
	const tag = (options.tag ?? '').trim();
	if (tag) {
		if (!TAG.test(tag)) {
			throw new AhelApiError(
				`Tag "${tag}" must be 1 to 64 lowercase letters, digits, dots, dashes or underscores.`,
				422,
				'invalid_arguments',
			);
		}
		headers['X-Ahel-Tag'] = tag;
	}
	return {
		method: 'GET',
		url: `${normaliseBaseUrl(baseUrl)}/api/v1/call/${encodeURIComponent(taskId)}?${query}`,
		headers,
		timeoutMs: (timeoutSeconds + 20) * 1000,
	};
}

function toNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Each row is {data, provenance}; the answer fields are in data. */
function rowFields(row: unknown): IDataObject {
	if (isObject(row) && isObject(row.data)) return row.data as IDataObject;
	return isObject(row) ? (row as IDataObject) : { value: row as IDataObject[string] };
}

/** One output item for one run: the first answer row's fields, all rows under
 *  `results` when there are more, and what the run cost and who served it. */
export function mapRun(view: Json): IDataObject {
	const rows = Array.isArray(view.rows) ? view.rows.map(rowFields) : [];
	const ledger = isObject(view.ledger) ? view.ledger : {};
	const chargeStatus = str(ledger.charge_status) ?? 'unknown';
	const settled = SETTLED.has(chargeStatus);
	const routing = isObject(view.routing) ? view.routing : {};
	const tried = Array.isArray(routing.tried) ? routing.tried.filter(isObject) : [];
	const servedBy = str(routing.served_by);
	const served = servedBy ? tried.find((t) => t.endpoint_id === servedBy) : undefined;
	const verification = isObject(routing.verification) ? routing.verification : null;
	const error = isObject(view.error) ? view.error : null;
	const state = str(view.state) ?? 'unknown';
	const out: IDataObject = { ...(rows[0] ?? {}) };
	if (rows.length > 1) out.results = rows;
	out.found = rows.length > 0;
	if (verification) out.verification = str(verification.verdict);
	// Settled: the exact charge. Still running: what is held for it.
	out.cost_usd = toNumber(settled ? (ledger.charged_usd ?? '0') : (ledger.held_usd ?? null));
	out.charge_status = chargeStatus;
	out.provider = served ? (str(served.provider_name) ?? servedBy) : servedBy;
	out.run_id = str(view.execution_id);
	out.task = str(view.capability_id);
	out.state = state;
	if (error) out.error = { code: str(error.code), message: str(error.message) };
	return out;
}

/** Whether a mapped run failed outright (no answer rows and a failed state). */
export function runFailed(out: IDataObject): boolean {
	return out.found === false && FAILED.has(String(out.state));
}

export function failureMessage(out: IDataObject): string {
	const error = isObject(out.error) ? out.error : {};
	const what = str(error.message) ?? str(error.code) ?? String(out.state);
	const charged = out.cost_usd ? `charged $${out.cost_usd}` : 'nothing charged';
	return `The run ${out.run_id ?? ''} ${String(out.state).replace(/_/g, ' ')}: ${what} (${charged}).`;
}

/** One output item for a quote: the most the run can reserve (only the exact
 *  cost is charged), the providers it would try in order, and the funds. */
export function mapQuote(taskId: string, quote: Json): IDataObject {
	const plan = Array.isArray(quote.attempt_plan) ? quote.attempt_plan.filter(isObject) : [];
	const ledger = isObject(quote.ledger) ? quote.ledger : {};
	const components = isObject(quote.components) ? quote.components : {};
	return {
		quote_only: true,
		task: taskId,
		quote_id: str(quote.quote_id),
		cost_usd: toNumber(quote.customer_total_usd),
		provider_estimate_usd: toNumber(components.provider_estimate_usd),
		platform_fee_usd: toNumber(components.platform_fee_usd),
		provider: plan.length ? (str(plan[0].provider_id) ?? str(plan[0].endpoint_id)) : null,
		attempt_plan: plan.map((step) => ({
			provider: str(step.provider_id),
			endpoint_id: str(step.endpoint_id),
			max_cost_usd: toNumber(step.max_cost_usd),
		})),
		reserve_note: str(quote.reserve_note),
		authorisable: quote.authorisable === undefined ? null : quote.authorisable === true,
		blocked_reason: str(quote.blocked_reason),
		available_usd: toNumber(ledger.available_usd),
		expires_at: str(quote.expires_at),
		run_id: null,
	};
}

/** String values typed by the input schema (a quote takes JSON, not a query string). */
export function coerceArguments(args: Record<string, unknown>, schema: unknown): IDataObject {
	const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : {};
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(args)) {
		if (value === undefined || value === null || value === '') continue;
		const spec = isObject(properties[key]) ? properties[key] : {};
		const type = spec.type;
		if (typeof value !== 'string') {
			out[key] = value as IDataObject[string];
		} else if (type === 'boolean') {
			out[key] = /^(true|1|yes)$/i.test(value.trim());
		} else if ((type === 'integer' || type === 'number') && toNumber(value) !== null) {
			out[key] = Number(value);
		} else if (type === 'array') {
			out[key] = value
				.split(/[\n,]/)
				.map((entry) => entry.trim())
				.filter(Boolean);
		} else {
			out[key] = value;
		}
	}
	return out;
}

/** The JSON arguments field as an object. */
export function parseArgumentsJson(text: unknown): IDataObject {
	if (isObject(text)) return text as IDataObject;
	const raw = typeof text === 'string' ? text.trim() : '';
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = undefined;
	}
	if (!isObject(parsed)) {
		throw new AhelApiError('Arguments must be a JSON object such as {"name": "Bolt"}.', 422, 'invalid_arguments');
	}
	return parsed as IDataObject;
}

/** "full_name=Name, domain" -> {full_name: item.Name, domain: item.domain}; empty: every field. */
export function rowArguments(item: IDataObject, mapping: string): IDataObject {
	const entries = mapping
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (!entries.length) return { ...item };
	const out: IDataObject = {};
	for (const entry of entries) {
		const [argument, field] = entry.split('=').map((part) => part.trim());
		const value = item[field || argument];
		if (value !== undefined && value !== null && value !== '') out[argument] = value;
	}
	return out;
}

export interface SearchHit {
	name: string;
	value: string;
	description?: string;
	url?: string;
}

export class AhelClient {
	private readonly baseUrl: string;
	private readonly now: () => number;
	private readonly minGapMs: number;
	private nextSlot = 0;
	private registry: { revision: string; capabilities: Json[] } | null = null;

	constructor(private readonly options: ClientOptions) {
		this.baseUrl = normaliseBaseUrl(options.baseUrl);
		this.now = options.now ?? Date.now;
		this.minGapMs = options.minGapMs ?? 2_100;
	}

	/** Waits for this request's slot so the workspace stays under 30 a minute. */
	private async paced(): Promise<void> {
		const now = this.now();
		const at = Math.max(now, this.nextSlot);
		this.nextSlot = at + this.minGapMs;
		if (at > now) await this.options.sleep(at - now);
	}

	/** One request. Retries a network failure (a run carries an Idempotency-Key,
	 *  so its retry answers the stored run) and 429 rate_limited, which refuses
	 *  before anything is quoted, held or run. Every other answer is returned. */
	async send(request: AhelRequest): Promise<AhelResponse> {
		let networkTries = 0;
		let limited = 0;
		let lastError = '';
		while (networkTries < NETWORK_TRIES) {
			await this.paced();
			let answer: AhelResponse | null = null;
			try {
				answer = await this.options.fetch(request);
			} catch (error) {
				lastError = (error as Error).message;
			}
			if (!answer) {
				networkTries++;
				if (networkTries < NETWORK_TRIES) await this.options.sleep(1_000 * 2 ** (networkTries - 1));
				continue;
			}
			const body = isObject(answer.body) ? answer.body : {};
			const code = isObject(body.error) ? str(body.error.code) : null;
			if (answer.status === 429 && code === 'rate_limited' && limited < RATE_LIMIT_TRIES) {
				limited++;
				const retryAfter = toNumber(answer.headers['retry-after']) ?? 10;
				await this.options.sleep(Math.min(60, Math.max(1, retryAfter)) * 1000);
				continue;
			}
			return answer;
		}
		throw new AhelApiError(`Ahel did not answer (${lastError || 'network error'}). Nothing new was run.`, 0, 'network');
	}

	private async json(
		method: 'GET' | 'POST',
		path: string,
		body?: IDataObject,
		timeoutMs = 30_000,
	): Promise<{ status: number; body: Json }> {
		const answer = await this.send({
			method,
			url: `${this.baseUrl}${path}`,
			headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
			...(body ? { body } : {}),
			timeoutMs,
		});
		return { status: answer.status, body: expectOk(answer) };
	}

	/** Runs one task and waits for it: one output item (see mapRun). */
	async run(id: string, args: Record<string, unknown>, options: RunOptions = {}): Promise<IDataObject> {
		const request = buildCallRequest(this.baseUrl, id, args, options, this.options.newKey());
		const started = expectOk(await this.send(request));
		let view: Json = started;
		const runId = str(view.execution_id);
		if (!runId) throw new AhelApiError('Ahel answered without a run id.', 502, 'bad_answer');
		const deadline = this.now() + ((options.timeoutSeconds ?? 60) + 30) * 1000;
		const ready = (v: Json) =>
			TERMINAL.has(String(v.state)) && SETTLED.has(String(isObject(v.ledger) ? v.ledger.charge_status : ''));
		// 202: still running when the call stopped waiting. Read it until it settles.
		let polled = false;
		while (!ready(view) && this.now() < deadline) {
			polled = true;
			await this.options.sleep(POLL_MS);
			const read = await this.json('GET', `/api/platform/v2/runs/${encodeURIComponent(runId)}`);
			view = { ...view, ...read.body, rows: view.rows };
		}
		const rows = Array.isArray(view.rows) ? view.rows : [];
		// A 200 carries its rows; a run read after a 202 has them under /results.
		if (polled && !rows.length && TERMINAL.has(String(view.state)) && !FAILED.has(String(view.state))) {
			const results = await this.json('GET', `/api/platform/v2/runs/${encodeURIComponent(runId)}/results?raw=0`);
			if (Array.isArray(results.body.rows)) view = { ...view, rows: results.body.rows };
		}
		return mapRun(view);
	}

	/** run, and an AhelApiError when the run failed outright. */
	async runChecked(id: string, args: Record<string, unknown>, options: RunOptions = {}): Promise<IDataObject> {
		const out = await this.run(id, args, options);
		if (runFailed(out)) throw new AhelApiError(failureMessage(out), 0, 'run_failed', str(out.run_id));
		return out;
	}

	private async loadRegistry(force = false): Promise<{ revision: string; capabilities: Json[] }> {
		if (this.registry && !force) return this.registry;
		const answer = await this.json('GET', '/api/platform/v2/capabilities');
		const service = isObject(answer.body.service) ? answer.body.service : {};
		const revision = str(service.registry_revision);
		if (!revision) throw new AhelApiError('Ahel answered without a registry revision.', 502, 'bad_answer');
		const capabilities = Array.isArray(answer.body.capabilities) ? answer.body.capabilities.filter(isObject) : [];
		this.registry = { revision, capabilities };
		return this.registry;
	}

	/** A task, capability or endpoint id as the capability a quote names. */
	private async resolve(id: string): Promise<{ capability: Json; endpointIds?: string[] }> {
		const { capabilities } = await this.loadRegistry();
		const direct = capabilities.find((c) => c.capability_id === id);
		if (direct) return { capability: direct };
		const byEndpoint = capabilities.find(
			(c) => Array.isArray(c.endpoints) && c.endpoints.some((e) => isObject(e) && e.endpoint_id === id),
		);
		if (byEndpoint) return { capability: byEndpoint, endpointIds: [id] };
		const item = (await this.json('GET', `/api/platform/v2/catalog/${encodeURIComponent(id)}`)).body;
		const capabilityId = Array.isArray(item.capability_ids) ? str(item.capability_ids[0]) : null;
		const capability = capabilities.find((c) => c.capability_id === capabilityId);
		if (!capability) {
			const why = str(item.reason) ?? str(item.status_label) ?? 'it has no runnable capability';
			throw new AhelApiError(`"${id}" cannot be quoted: ${why}.`, 409, str(item.status) ?? 'no_binding');
		}
		const pinned = Array.isArray(item.bound_endpoint_ids) ? item.bound_endpoint_ids.filter((e) => typeof e === 'string') : [];
		return { capability, ...(item.kind === 'tool' && pinned.length ? { endpointIds: pinned as string[] } : {}) };
	}

	/** The exact price of one run, nothing held or run: one output item (see mapQuote). */
	async quote(id: string, args: Record<string, unknown>, options: RunOptions = {}): Promise<IDataObject> {
		const taskId = checkId(id);
		const { capability, endpointIds } = await this.resolve(taskId);
		const body = (revision: string): IDataObject => ({
			capability_id: String(capability.capability_id),
			registry_revision: revision,
			arguments: coerceArguments(args, capability.inputs),
			limits: { max_items: options.maxItems ?? 1, timeout_seconds: options.timeoutSeconds ?? 60 },
			...(endpointIds ? { endpoint_ids: endpointIds } : {}),
		});
		const first = await this.send(this.post('/api/platform/v2/quotes', body((await this.loadRegistry()).revision)));
		const firstBody = isObject(first.body) ? first.body : {};
		if (first.status === 409 && isObject(firstBody.error) && firstBody.error.code === 'registry_changed') {
			const again = await this.send(this.post('/api/platform/v2/quotes', body((await this.loadRegistry(true)).revision)));
			return mapQuote(taskId, expectOk(again));
		}
		return mapQuote(taskId, expectOk(first));
	}

	private post(path: string, body: IDataObject): AhelRequest {
		return {
			method: 'POST',
			url: `${this.baseUrl}${path}`,
			headers: { accept: 'application/json', 'content-type': 'application/json' },
			body,
			timeoutMs: 30_000,
		};
	}

	/** Catalog search for the task dropdown. */
	async search(query: string): Promise<SearchHit[]> {
		const answer = await this.json('GET', `/api/platform/v2/catalog?${queryString({ q: query.slice(0, 200), limit: 25 })}`);
		const items = Array.isArray(answer.body.items) ? answer.body.items.filter(isObject) : [];
		return items.map((item) => {
			const id = String(item.id);
			const ready = item.status === 'ready';
			const price = str(item.price_from);
			const summary = [str(item.summary), price ? `from ${price}` : null].filter(Boolean).join(' · ');
			const webPath = str(item.web_path);
			return {
				name: `${str(item.label) ?? id} (${id})${ready ? '' : ` · ${str(item.status_label) ?? 'not ready'}`}`,
				value: id,
				...(summary ? { description: summary } : {}),
				...(webPath ? { url: `${this.baseUrl}${webPath}` } : {}),
			};
		});
	}
}

/** The body of a 2xx answer, or an AhelApiError with the API's own message. */
export function expectOk(answer: AhelResponse): Json {
	const body = isObject(answer.body) ? answer.body : {};
	if (answer.status >= 200 && answer.status < 300) return body;
	const error = isObject(body.error) ? body.error : {};
	const code = str(error.code) ?? `http_${answer.status}`;
	const message = str(error.message) ?? `Ahel answered HTTP ${answer.status}.`;
	throw new AhelApiError(message, answer.status, code);
}

export interface ListRow {
	taskId: string;
	args: IDataObject;
	options: RunOptions;
	/** Fields kept from the input item; the answer goes next to them. */
	base: IDataObject;
}

/** Runs `count` rows of a list, `parallel` at a time (1 to 5), each through the
 *  same call as one run. Every row keeps its place: a refused or failed row
 *  carries error and error_code, so the rows already paid for are never lost.
 *  Requests stay spaced by the client, so a long list keeps under the limit. */
export async function runRows(
	client: AhelClient,
	count: number,
	prepare: (index: number) => ListRow,
	parallel = 3,
): Promise<{ rows: IDataObject[]; errors: Array<{ index: number; error: Error }> }> {
	const rows: IDataObject[] = new Array(count);
	const errors: Array<{ index: number; error: Error }> = [];
	let next = 0;
	const one = async (i: number) => {
		let base: IDataObject = {};
		try {
			const row = prepare(i);
			base = row.base;
			const out = await client.run(row.taskId, row.args, row.options);
			if (runFailed(out)) {
				const message = failureMessage(out);
				errors.push({ index: i, error: new AhelApiError(message, 0, 'run_failed', str(out.run_id)) });
				rows[i] = { ...base, ...out, error: message, error_code: 'run_failed' };
				return;
			}
			rows[i] = { ...base, ...out };
		} catch (error) {
			errors.push({ index: i, error: error as Error });
			rows[i] = {
				...base,
				error: (error as Error).message,
				error_code: error instanceof AhelApiError ? error.code : 'error',
				cost_usd: 0,
			};
		}
	};
	const worker = async () => {
		while (next < count) await one(next++);
	};
	const width = Math.min(5, Math.max(1, Math.floor(parallel)), count);
	await Promise.all(Array.from({ length: width }, worker));
	errors.sort((a, b) => a.index - b.index);
	return { rows, errors };
}
