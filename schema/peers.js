'use strict';

module.exports = {
	updatePeersList: {
		peers: {
			id: 'peer.updatePeersList.peers',
			type: 'object',
			properties: {
				peers: {
					type: 'array',
					uniqueItems: true
				}
			},
			required: ['peers']
		},
		peer: {
			id: 'peer.updatePeersList.peer',
			type: 'object',
			properties: {
				ip: {
					type: 'string',
					format: 'ip'
				},
				port: {
					type: 'integer',
					minimum: 1,
					maximum: 65535
				},
				state: {
					type: 'integer',
					minimum: 0,
					maximum: 2
				},
				os: {
					type: 'string',
					format: 'os',
					minLength: 1,
					maxLength: 64
				},
				version: {
					type: 'string',
					format: 'version',
					minLength: 5,
					maxLength: 12
				}
			},
			required: ['ip', 'port', 'state']
		}
	},
	getPeers: {
		id: 'peer.getPeers',
		type: 'object',
		properties: {
			ip: {
				type: 'string',
				format: 'ip'
			},
			port: {
				type: 'integer',
				minimum: 1,
				maximum: 65535
			},
			state: {
				type: 'integer',
				minimum: 0,
				maximum: 2
			},
			os: {
				type: 'string',
				format: 'os',
				minLength: 1,
				maxLength: 64
			},
			version: {
				type: 'string',
				format: 'version',
				minLength: 5,
				maxLength: 12
			},
			orderBy: {
				type: 'string'
			},
			limit: {
				type: 'integer',
				minimum: 1,
				maximum: 100
			},
			offset: {
				type: 'integer',
				minimum: 0
			}
		}
	},
	getPeer: {
		id: 'peer.getPeer',
		type: 'object',
		properties: {
			ip: {
				type: 'string',
				format: 'ip'
			},
			port: {
				type: 'integer',
				minimum: 0,
				maximum: 65535
			}
		},
		required: ['ip', 'port']
	}
};
