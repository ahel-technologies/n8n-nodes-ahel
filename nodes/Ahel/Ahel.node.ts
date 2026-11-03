import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, randomString, sleep } from 'n8n-workflow';

import {
	AhelApiError,
	AhelClient,
	cleanDomain,
	parseArgumentsJson,
	rowArguments,
	runRows,
	type AhelFetch,
	type RunOptions,
} from './client';

/** Ahel's API through n8n's own HTTP helper, which adds the credential's header. */
function transportFor(context: IExecuteFunctions | ILoadOptionsFunctions): AhelFetch {
	return async (request) => {
		const options: IHttpRequestOptions = {
			method: request.method,
			url: request.url,
			headers: request.headers,
			json: true,
			timeout: request.timeoutMs,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			...(request.body ? { body: request.body } : {}),
		};
		const response = (await context.helpers.httpRequestWithAuthentication.call(
			context,
			'ahelApi',
			options,
		)) as { statusCode: number; headers?: IDataObject; body: unknown };
		return { status: response.statusCode, headers: response.headers ?? {}, body: response.body };
	};
}

async function clientFor(context: IExecuteFunctions | ILoadOptionsFunctions, minGapMs?: number) {
	const credentials = await context.getCredentials('ahelApi');
	return new AhelClient({
		baseUrl: typeof credentials.baseUrl === 'string' ? credentials.baseUrl : undefined,
		fetch: transportFor(context),
		sleep,
		newKey: () => `n8n_${randomString(32)}`,
		...(minGapMs ? { minGapMs } : {}),
	});
}

function runOptionsAt(context: IExecuteFunctions, index: number): RunOptions {
	const options = context.getNodeParameter('options', index, {}) as IDataObject;
	return {
		...(options.tag ? { tag: String(options.tag) } : {}),
		...(Number(options.maxCostUsd) > 0 ? { maxCostUsd: Number(options.maxCostUsd) } : {}),
		maxItems: Number(options.maxResults ?? 1) || 1,
		timeoutSeconds: Number(options.timeoutSeconds ?? 60) || 60,
	};
}

function taskIdAt(context: IExecuteFunctions, index: number): string {
	return String(context.getNodeParameter('task', index, '', { extractValue: true }) ?? '').trim();
}

function pairsAt(context: IExecuteFunctions, parameter: string, index: number): IDataObject {
	const fields = context.getNodeParameter(`${parameter}.field`, index, []) as Array<{ name: string; value: string }>;
	const args: IDataObject = {};
	for (const field of fields) if (field.name) args[field.name.trim()] = field.value;
	return args;
}

function runTaskArguments(context: IExecuteFunctions, index: number): IDataObject {
	const mode = context.getNodeParameter('argumentsMode', index, 'json') as string;
	if (mode === 'json') return parseArgumentsJson(context.getNodeParameter('argumentsJson', index, '{}'));
	return pairsAt(context, 'argumentFields', index);
}

function apiError(context: IExecuteFunctions, error: AhelApiError, itemIndex?: number): NodeApiError {
	return new NodeApiError(context.getNode(), { code: error.code, message: error.message } as JsonObject, {
		message: error.message,
		description: `Ahel answered ${error.code}${error.status ? ` (HTTP ${error.status})` : ''}.`,
		...(error.status ? { httpCode: String(error.status) } : {}),
		...(itemIndex === undefined ? {} : { itemIndex }),
	});
}

export class Ahel implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Ahel',
		name: 'ahel',
		icon: { light: 'file:ahel.svg', dark: 'file:ahel.dark.svg' },
		group: ['transform'],
		version: [1],
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Run pay-per-call data tasks on Ahel: find work emails, check European companies in the register, or any task in the catalog. Every item carries its exact cost.',
		defaults: {
			name: 'Ahel',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'ahelApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Check a European Company',
						value: 'checkCompany',
						action: 'Check a european company in the register',
						description: 'Look a company up in its official register by name and country (companies.register.search)',
					},
					{
						name: 'Find Work Email',
						value: 'findWorkEmail',
						action: 'Find a work email',
						description: 'Find the work email from a full name and the company domain (people.email.find)',
					},
					{
						name: 'Run a List',
						value: 'runList',
						action: 'Run a task for every incoming item',
						description: 'Run one task per incoming item, a few at a time, each row with its own cost',
					},
					{
						name: 'Run Task',
						value: 'runTask',
						action: 'Run a task',
						description: 'Run any task in the Ahel catalog, or only quote its price',
					},
				],
				default: 'findWorkEmail',
			},

			// ------------------------------------------------ run task / run a list
			{
				displayName: 'Task',
				name: 'task',
				type: 'resourceLocator',
				default: { mode: 'list', value: '' },
				required: true,
				description: 'The catalog task to run',
				displayOptions: { show: { operation: ['runTask', 'runList'] } },
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						placeholder: 'Search the catalog…',
						typeOptions: {
							searchListMethod: 'searchTasks',
							searchable: true,
						},
					},
					{
						displayName: 'ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. people.email.find',
					},
				],
			},
			{
				displayName: 'Arguments Mode',
				name: 'argumentsMode',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'JSON', value: 'json' },
					{ name: 'Key/Value Pairs', value: 'fields' },
				],
				default: 'json',
				displayOptions: { show: { operation: ['runTask'] } },
			},
			{
				displayName: 'Arguments (JSON)',
				name: 'argumentsJson',
				type: 'json',
				default: '{}',
				required: true,
				description: 'The task\'s arguments, for example {"name": "Bolt", "country": "EE"}. Inspect a task on ahel.ai to see its inputs.',
				displayOptions: { show: { operation: ['runTask'], argumentsMode: ['json'] } },
			},
			{
				displayName: 'Arguments',
				name: 'argumentFields',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Argument',
				displayOptions: { show: { operation: ['runTask'], argumentsMode: ['fields'] } },
				options: [
					{
						name: 'field',
						displayName: 'Argument',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Quote Only',
				name: 'quoteOnly',
				type: 'boolean',
				default: false,
				description:
					'Whether to only price the run: answers the most it can reserve and the providers in order, and holds, runs and charges nothing',
				displayOptions: { show: { operation: ['runTask'] } },
			},

			// ------------------------------------------------ find work email
			{
				displayName: 'Full Name',
				name: 'fullName',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g. Jane Doe',
				displayOptions: { show: { operation: ['findWorkEmail'] } },
			},
			{
				displayName: 'Company Domain',
				name: 'domain',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g. example.com',
				description: 'The company website or domain; https:// and www. are removed.',
				displayOptions: { show: { operation: ['findWorkEmail'] } },
			},
			{
				displayName: 'Verify',
				name: 'verify',
				type: 'boolean',
				default: true,
				description:
					'Whether to check in the same run that the found address accepts mail (adds about $0.0011); the verdict is in the verification field',
				displayOptions: { show: { operation: ['findWorkEmail'] } },
			},

			// ------------------------------------------------ check a European company
			{
				displayName: 'Company Name',
				name: 'companyName',
				type: 'string',
				default: '',
				required: true,
				placeholder: 'e.g. Bolt Technology',
				displayOptions: { show: { operation: ['checkCompany'] } },
			},
			{
				displayName: 'Country',
				name: 'country',
				type: 'string',
				default: '',
				placeholder: 'e.g. EE',
				description: 'Two-letter country code (ISO 3166), for example EE, DE, FR or GB',
				displayOptions: { show: { operation: ['checkCompany'] } },
			},

			// ------------------------------------------------ run a list
			{
				displayName: 'Arguments From Fields',
				name: 'fieldMapping',
				type: 'string',
				default: '',
				placeholder: 'e.g. full_name=Name, domain=Website',
				description:
					'Which item fields to send, comma-separated: "domain" sends the field domain, "full_name=Name" sends the field Name as full_name. Empty sends every field.',
				displayOptions: { show: { operation: ['runList'] } },
			},
			{
				displayName: 'Extra Arguments',
				name: 'extraArguments',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				placeholder: 'Add Argument',
				description: 'Arguments added to every row, for example verify = true',
				displayOptions: { show: { operation: ['runList'] } },
				options: [
					{
						name: 'field',
						displayName: 'Argument',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Keep Input Fields',
				name: 'keepInputFields',
				type: 'boolean',
				default: true,
				description: 'Whether each output item keeps the fields of its input item next to the answer',
				displayOptions: { show: { operation: ['runList'] } },
			},
			{
				displayName: 'Parallel Runs',
				name: 'parallelRuns',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 5 },
				default: 3,
				description: 'How many rows run at once. Requests are spaced to stay under the workspace limit of 30 a minute.',
				displayOptions: { show: { operation: ['runList'] } },
			},

			// ------------------------------------------------ options
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Max Cost per Run (USD)',
						name: 'maxCostUsd',
						type: 'number',
						typeOptions: { minValue: 0, numberPrecision: 4 },
						default: 0,
						description:
							'Refuse a run quoted above this, holding and charging nothing; only providers that fit are tried. 0 means no cap.',
					},
					{
						displayName: 'Max Results',
						name: 'maxResults',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 100 },
						default: 1,
						description: 'Most answer rows per run. The first row\'s fields are on the item; with more, all rows are under results.',
					},
					{
						displayName: 'Tag',
						name: 'tag',
						type: 'string',
						default: '',
						placeholder: 'e.g. acme-corp',
						description:
							'Tags the run for usage by tag in Activity on ahel.ai: 1 to 64 lowercase letters, digits, dots, dashes or underscores. Never sent to a provider.',
					},
					{
						displayName: 'Timeout (Seconds)',
						name: 'timeoutSeconds',
						type: 'number',
						typeOptions: { minValue: 5, maxValue: 180 },
						default: 60,
						description: 'How long a run may take',
					},
				],
			},
		],
	};

	methods = {
		listSearch: {
			async searchTasks(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
				const client = await clientFor(this, 1);
				try {
					return { results: await client.search(filter ?? '') };
				} catch (error) {
					throw new NodeOperationError(this.getNode(), (error as Error).message);
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const operation = this.getNodeParameter('operation', 0) as string;
		const client = await clientFor(this);
		if (operation === 'runList') return [await runList(this, client)];

		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				const options = runOptionsAt(this, i);
				let json: IDataObject;
				if (operation === 'runTask') {
					const taskId = taskIdAt(this, i);
					const args = runTaskArguments(this, i);
					json = this.getNodeParameter('quoteOnly', i, false)
						? await client.quote(taskId, args, options)
						: await client.runChecked(taskId, args, options);
				} else if (operation === 'findWorkEmail') {
					json = await client.runChecked(
						'people.email.find',
						{
							full_name: String(this.getNodeParameter('fullName', i)).trim().replace(/\s+/g, ' '),
							domain: cleanDomain(String(this.getNodeParameter('domain', i))),
							verify: this.getNodeParameter('verify', i, true) as boolean,
						},
						options,
					);
				} else if (operation === 'checkCompany') {
					const country = String(this.getNodeParameter('country', i, '')).trim().toUpperCase();
					json = await client.runChecked(
						'companies.register.search',
						{ name: String(this.getNodeParameter('companyName', i)).trim(), ...(country ? { country } : {}) },
						options,
					);
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation "${operation}"`, { itemIndex: i });
				}
				out.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({
						json: { error: (error as Error).message, ...(error instanceof AhelApiError ? { error_code: error.code } : {}) },
						pairedItem: { item: i },
					});
					continue;
				}
				if (error instanceof AhelApiError) throw apiError(this, error, i);
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [out];
	}
}

/** Every incoming item as one run of the same task (client.ts runRows). The
 *  node fails only when every row failed; otherwise failed rows carry error. */
async function runList(context: IExecuteFunctions, client: AhelClient): Promise<INodeExecutionData[]> {
	const items = context.getInputData();
	const parallel = Number(context.getNodeParameter('parallelRuns', 0, 3)) || 1;
	const { rows, errors } = await runRows(
		client,
		items.length,
		(i) => ({
			taskId: taskIdAt(context, i),
			args: {
				...rowArguments(items[i].json, String(context.getNodeParameter('fieldMapping', i, ''))),
				...pairsAt(context, 'extraArguments', i),
			},
			options: runOptionsAt(context, i),
			base: (context.getNodeParameter('keepInputFields', i, true) as boolean) ? { ...items[i].json } : {},
		}),
		parallel,
	);
	if (items.length && errors.length === items.length && !context.continueOnFail()) {
		const first = errors[0];
		if (first.error instanceof AhelApiError) throw apiError(context, first.error, first.index);
		throw new NodeOperationError(context.getNode(), first.error, { itemIndex: first.index });
	}
	return rows.map((json, i) => ({ json, pairedItem: { item: i } }));
}
