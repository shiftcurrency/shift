'use strict';

var _ = require('lodash');
var async = require('async');
var extend = require('extend');
var fs = require('fs');
var ip = require('ip');
var OrderBy = require('../helpers/orderBy.js');
var path = require('path');
var Router = require('../helpers/router.js');
var sandboxHelper = require('../helpers/sandbox.js');
var constants = require('../helpers/constants.js');
var schema = require('../schema/peers.js');
var sql = require('../sql/peers.js');
var util = require('util');
var sql_escape = require('../helpers/sql_escaping.js');

// Private fields
var modules, library, self, __private = {}, shared = {};

// List of peers not behaving well
// reset when we restart
var removed = [];

// Constructor
function Peers (cb, scope) {
	library = scope;
	self = this;

	__private.attachApi();

	setImmediate(cb, null, self);
}

// Private methods
__private.attachApi = function () {
	var router = new Router();

	router.use(function (req, res, next) {
		if (modules) { return next(); }
		res.status(500).send({success: false, error: 'Blockchain is loading'});
	});

	router.map(shared, {
		'get /': 'getPeers',
		'get /version': 'version',
		'get /get': 'getPeer'
	});

	router.use(function (req, res) {
		res.status(500).send({success: false, error: 'API endpoint not found'});
	});

	library.network.app.use('/api/peers', router);
	library.network.app.use(function (err, req, res, next) {
		if (!err) { return next(); }
		library.logger.error('API error ' + req.url, err);
		res.status(500).send({success: false, error: 'API error: ' + err.message});
	});
};

__private.updatePeersList = function (cb) {
	modules.transport.getFromRandomPeer({
		api: '/list',
		method: 'GET'
	}, function (err, res) {
		if (err) {
			return setImmediate(cb);
		}

		library.schema.validate(res.body, schema.updatePeersList.peers, function (err) {
			if (err) {
				return setImmediate(cb);
			}

			// Removing nodes not behaving well
			library.logger.debug('Removed peers: ' + removed.length);
			var peers = res.body.peers.filter(function (peer) {
					return removed.indexOf(peer.ip);
			});

			// Update only a subset of the peers to decrease the noise on the network.
			// Default is 20 peers. To be fined tuned. Node gets checked by a peer every 3s on average.
			// Maybe increasing schedule (every 60s right now).
			var maxUpdatePeers = Math.floor(library.config.peers.options.maxUpdatePeers) || 20;
			if (peers.length > maxUpdatePeers) {
				peers = peers.slice(0, maxUpdatePeers);
			}

			// Drop one random peer from removed array to give them a chance.
			// This mitigates the issue that a node could be removed forever if it was offline for long.
			// This is not harmful for the node, but prevents network from shrinking, increasing noise.
			// To fine tune: decreasing random value threshold -> reduce noise.
			if (Math.random() < 0.5) { // Every 60/0.5 = 120s
				// Remove the first element,
				// i.e. the one that have been placed first.
				removed.shift();
				removed.pop();
			}

			library.logger.debug(['Picked', peers.length, 'of', res.body.peers.length, 'peers'].join(' '));

			async.eachLimit(peers, 2, function (peer, cb) {

				peer = self.inspect(peer);

				if (peer.version<constants.minVersion) {
					library.logger.warn(['Rejecting peer (invalid version):', peer.ip, 'Version', peer.version].join(' '));
					return setImmediate(cb);
					}

				library.schema.validate(peer, schema.updatePeersList.peer, function (err) {
					if (err) {
						err.forEach(function (e) {
							library.logger.error(['Rejecting invalid peer:', peer.ip, e.path, e.message].join(' '));
						});

						return setImmediate(cb);
					} else {
						library.dbSequence.add(function (cb) {
							self.update(peer, cb);
						});

						return setImmediate(cb);
					}
				});
			}, cb);
		});
	});
};

__private.count = function (cb) {
	library.db.query(sql.count).then(function (rows) {
		var res = rows.length && rows[0].count;
		return setImmediate(cb, null, res);
	}).catch(function (err) {
		library.logger.error(err.stack);
		return setImmediate(cb, 'Peers#count error');
	});
};

__private.banManager = function (cb) {
	library.db.query(sql.banManager, { now: Date.now() }).then(function (res) {
		return setImmediate(cb, null, res);
	}).catch(function (err) {
		library.logger.error(err.stack);
		return setImmediate(cb, 'Peers#banManager error');
	});
};

__private.getByFilter = function (filter, cb) {
	var where = [];
	var params = {};

	if (filter.state >= 0) {
		where.push('"state" = ${state}');
		params.state = filter.state;
	}

	if (filter.os) {
		where.push('"os" = ${os}');
		params.os = filter.os;
	}

	if (filter.version) {
		where.push('"version" = ${version}');
		params.version = filter.version;
	}

	if (filter.ip) {
		where.push('"ip" = ${ip}');
		params.ip = filter.ip;
	}

	if (filter.port) {
		where.push('"port" = ${port}');
		params.port = filter.port;
	}

	if (!filter.limit) {
		params.limit = 100;
	} else {
		params.limit = Math.abs(filter.limit);
	}

	if (!filter.offset) {
		params.offset = 0;
	} else {
		params.offset = Math.abs(filter.offset);
	}

	if (params.limit > 100) {
		return setImmediate(cb, 'Invalid limit. Maximum is 100');
	}

	var orderBy = OrderBy(
		filter.orderBy, {
			sortFields: sql.sortFields
		}
	);

	if (orderBy.error) {
		return setImmediate(cb, orderBy.error);
	}

	library.db.query(sql.getByFilter({
		where: where,
		sortField: orderBy.sortField,
		sortMethod: orderBy.sortMethod
	}), params).then(function (rows) {
		return setImmediate(cb, null, rows);
	}).catch(function (err) {
		library.logger.error(err.stack);
		return setImmediate(cb, 'Peers#getByFilter error');
	});
};

// Public methods
Peers.prototype.inspect = function (peer) {
	peer = peer || {};

	if (/^[0-9]+$/.test(peer.ip)) {
		peer.ip = ip.fromLong(peer.ip);
	}

	peer.port = parseInt(peer.port);
	peer.port = isNaN(peer.port) ? 0 : peer.port;

	if (peer.ip) {
		peer.string = (peer.ip + ':' + peer.port || 'unknown');
	} else {
		peer.string = 'unknown';
	}

	peer.os = peer.os || 'unknown';
	peer.version = peer.version || '0.0.0';

	return peer;
};

Peers.prototype.list = function (options, cb) {
	options.limit = options.limit || 100;

	library.db.query(sql.randomList(options), options).then(function (rows) {
		return setImmediate(cb, null, rows);
	}).catch(function (err) {
		library.logger.error(err.stack);
		return setImmediate(cb, 'Peers#list error');
	});
};

Peers.prototype.state = function (pip, port, state, timeoutSeconds, cb) {
	var isFrozenList = _.find(library.config.peers, function (peer) {
		return peer.ip === pip && peer.port === port;
	});
	if (isFrozenList !== undefined && cb) {
		return setImmediate(cb, 'Peer in white list');
	}
	var clock;
	if (state === 0) {
		clock = (timeoutSeconds || 1) * 1000;
		clock = Date.now() + clock;
	} else {
		clock = null;
	}
	var params = {
		state: sql_escape(state),
		clock: sql_escape(clock),
		ip: sql_escape(pip),
		port: sql_escape(port)
	};
	library.db.query(sql.state, params).then(function (res) {
		library.logger.debug('Updated peer state', params);
		return cb && setImmediate(cb, null, res);
	}).catch(function (err) {
		library.logger.error(err.stack);
		return cb && setImmediate(cb);
	});
};

Peers.prototype.remove = function (pip, port, cb) {
	var isFrozenList = _.find(library.config.peers.list, function (peer) {
		return peer.ip === pip && peer.port === port;
	});
	if (isFrozenList !== undefined && cb) {
		return setImmediate(cb, 'Peer in white list');
	}
	removed.push(pip);
	var params = {
		ip: pip,
		port: port
	};
	library.db.query(sql.remove, params).then(function (res) {
		library.logger.debug('Removed peer', params);
		return cb && setImmediate(cb, null, res);
	}).catch(function (err) {
		library.logger.error(err.stack);
		return cb && setImmediate(cb);
	});
};

Peers.prototype.addDapp = function (config, cb) {
	library.db.task(function (t) {
		return t.query(sql.getByIdPort, { ip: config.ip, port: config.port }).then(function (rows) {
			if (rows.length) {
				var params = {
					dappId: config.dappid,
					peerId: rows[0].id
				};

				return t.query(sql.addDapp, params).then(function (res) {
					library.logger.debug('Added dapp peer', params);
				});
			} else {
				return t;
			}
		});
	}).then(function (res) {
		return setImmediate(cb, null, res);
	}).catch(function (err) {
		library.logger.error(err.stack);
		return setImmediate(cb, 'Peers#addDapp error');
	});
};

Peers.prototype.update = function (peer, cb) {
	var params = {
		ip: sql_escape(peer.ip),
		port: sql_escape(peer.port),
		os: sql_escape(peer.os) || null,
		version: sql_escape(peer.version) || null,
		state: 1
	};

	var query;
	if (peer.state !== undefined) {
		params.state = peer.state;
		query = sql.upsertWithState;
	} else {
		query = sql.upsertWithoutState;
	}

	library.db.query(query, params).then(function () {
		library.logger.debug('Upserted peer', params);

		if (peer.dappid) {
			return self.addDapp({dappid: sql_escape(peer.dappid), ip: sql_escape(peer.ip), port: sql_escape(peer.port)}, cb);
		} else {
			return setImmediate(cb);
		}
	}).catch(function (err) {
		library.logger.error(err.stack);
		return setImmediate(cb, 'Peers#update error');
	});
};

Peers.prototype.sandboxApi = function (call, args, cb) {
	sandboxHelper.callMethod(shared, call, args, cb);
};

// Events
Peers.prototype.onBind = function (scope) {
	modules = scope;
};

Peers.prototype.onBlockchainReady = function () {
	async.eachSeries(library.config.peers.list, function (peer, cb) {
		var params = {
			ip: sql_escape(peer.ip),
			port: sql_escape(peer.port),
			state: 2
		};
		library.db.query(sql.insertSeed, params).then(function (res) {
			library.logger.debug('Inserted seed peer', params);
			return setImmediate(cb, null, res);
		}).catch(function (err) {
			library.logger.error(err.stack);
			return setImmediate(cb, 'Peers#onBlockchainReady error');
		});
	}, function (err) {
		if (err) {
			library.logger.error(err);
		}

		__private.count(function (err, count) {
			if (count) {
				__private.updatePeersList(function (err) {
					if (err) {
						library.logger.error('Peers#updatePeersList error', err);
					}
					library.bus.message('peersReady');
				});
				library.logger.info('Peers ready, stored ' + count);
			} else {
				library.logger.warn('Peers list is empty');
				library.bus.message('peersReady');
			}
		});
	});
};

Peers.prototype.onPeersReady = function () {
	setImmediate(function nextUpdatePeersList () {
		__private.updatePeersList(function (err) {
			if (err) {
				library.logger.error('Peers timer:', err);
			}
			setTimeout(nextUpdatePeersList, 60 * 1000);
		});
	});

	setImmediate(function nextBanManager () {
		__private.banManager(function (err) {
			if (err) {
				library.logger.error('Ban manager timer:', err);
			}
			setTimeout(nextBanManager, 65 * 1000);
		});
	});
};

// Shared

shared.getPeers = function (req, cb) {
	library.schema.validate(req.body, schema.getPeers, function (err) {
		if (err) {
			return setImmediate(cb, err[0].message);
		}

		if (req.body.limit < 0 || req.body.limit > 100) {
			return setImmediate(cb, 'Invalid limit. Maximum is 100');
		}

		__private.getByFilter(req.body, function (err, peers) {
			if (err) {
				return setImmediate(cb, 'Failed to get peers');
			}

			return setImmediate(cb, null, {peers: peers});
		});
	});
};

shared.getPeer = function (req, cb) {
	library.schema.validate(req.body, schema.getPeer, function (err) {
		if (err) {
			return setImmediate(cb, err[0].message);
		}

		__private.getByFilter({
			ip: req.body.ip,
			port: req.body.port
		}, function (err, peers) {
			if (err) {
				return setImmediate(cb, 'Failed to get peer');
			}

			if (peers.length) {
				return setImmediate(cb, null, {success: true, peer: peers[0]});
			} else {
				return setImmediate(cb, null, {success: false, error: 'Peer not found'});
			}
		});
	});
};

shared.version = function (req, cb) {
	return setImmediate(cb, null, {version: constants.currentVersion, build: library.build});
};

// Export
module.exports = Peers;
