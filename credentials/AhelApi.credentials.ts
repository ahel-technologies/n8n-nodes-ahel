import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class AhelApi implements ICredentialType {
	name = 'ahelApi';

	displayName = 'Ahel API';

	icon: Icon = { light: 'file:../nodes/Ahel/ahel.svg', dark: 'file:../nodes/Ahel/ahel.dark.svg' };

	documentationUrl = 'https://github.com/ahel-technologies/n8n-nodes-ahel#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'ahel_tk_...',
			description: 'A team API key from https://ahel.ai/app/team?tab=keys. New workspaces start with $1 free.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://ahel.ai',
			description: 'Leave as is unless Ahel support gives you another address',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				'X-Ahel-Token': '={{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl || "https://ahel.ai"}}',
			url: '/api/platform/v2/balance',
			method: 'GET',
		},
	};
}
