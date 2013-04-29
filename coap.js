

var util = require('util');
var Stream = require('stream');
var url = require('url');
var CoAPParser = require('./build/Release/coap_parser');
var EventEmitter = require('events').EventEmitter;
var dgram = require('dgram');
var assert = require('assert').ok;
var crypto = require('crypto');
var dns = require('dns'),
    net = require('net');

////////////////////////////////////////////////////////////////////////////////

function coapToHTTPCode(x) { return ((x) / 32 * 100 + (x) % 32); }
function httpToCOAPCode(x) { return ((x) / 100 * 32 + (x) % 100); }
function codeIsRequest(x) { return (x > 0) && (x<httpToCOAPCode(100)); }
function codeIsResponse(x) { return (x>=httpToCOAPCode(100)); }

////////////////////////////////////////////////////////////////////////////////

var DEFAULT_PORT = exports.DEFAULT_PORT = 5683;

var CODE_EMPTY = exports.CODE_EMPTY = 0;
var CODE_GET = exports.CODE_GET = 1;
var CODE_POST = exports.CODE_POST = 2;
var CODE_PUT = exports.CODE_PUT = 3;
var CODE_DELETE = exports.CODE_DELETE = 4;

var CODE_2_05_CONTENT = exports.CODE_2_05_CONTENT = httpToCOAPCode(205);

var TT_CON = exports.TT_CON = 0;
var TT_NON = exports.TT_NON = 1;
var TT_ACK = exports.TT_ACK = 2;
var TT_RESET = exports.TT_RESET = 3;

var OPTION_URI_ETAG = exports.OPTION_URI_ETAG = 2;
var OPTION_URI_HOST = exports.OPTION_URI_HOST = 3;
var OPTION_OBSERVE = exports.OPTION_OBSERVE = 6;
var OPTION_URI_PORT = exports.OPTION_URI_PORT = 7;
var OPTION_URI_PATH = exports.OPTION_URI_PATH = 11;
var OPTION_CONTENT_TYPE = exports.OPTION_CONTENT_TYPE = 12;
var OPTION_URI_QUERY = exports.OPTION_URI_QUERY = 15;


////////////////////////////////////////////////////////////////////////////////

function coapToHTTPCode(x) { return (~~((x) / 32) * 100 + (x) % 32); }
function httpToCOAPCode(x) { return (~~((x) / 100) * 32 + (x) % 100); }
function codeIsRequest(x) { return (x > 0) && (x<httpToCOAPCode(100)); }
function codeIsResponse(x) { return (x>=httpToCOAPCode(100)); }

////////////////////////////////////////////////////////////////////////////////

function InboundStream(msg,from,to,info) {
	Stream.Readable.call(this);

	this.server = server;
	this.options = msg.options;
	this.code = msg.code;
	this.tt = msg.tt;
	this.msgid = msg.msgid;
	this.token = msg.token;
	this.from = from;
	this.to = to;
	this.info = info;
}
util.inherits(InboundStream,Stream.Readable);

InboundStream.prototype.ingestMessage = function (msg,from,to,info) {
	this.options = msg.options;
	this.code = msg.code;
	this.tt = msg.tt;
	this.msgid = msg.msgid;
	this.from = from;
	this.to = to;
	this.info = info;

	this.push(msg.content);
}

////////////////////////////////////////////////////////////////////////////////

function OutboundMessage(server,to,from) {

	this.server = server;
	this.options = {};
	this.code = CODE_EMPTY;
	this.tt = TT_NON;
	this.msgid = 0;
	this.to = to;
	this.from = from;
	this.did_send = false;
	this.did_defer = false;
	this.date_created = Date.now();
}

OutboundMessage.prototype._send = function(cb) {
	if(!this.did_send) {
		this.defer(cb);
	} else {
		var msg = {
			code: this.code,
			tt: this.tt,
			msgid: this.msgid,
			token: this.token,
			to: this.to,
			from: this.from,
		};
		if(this.content !== undefined)
			msg.content = this.content;
		this.server.sendRequest(msg,function (msg,err) {
//			console.log(" *** BLAAAAH: " + err);
//			console.log(msg);
			if(typeof cb === 'function')
				cb(err);
		});
	}
}

OutboundMessage.prototype.defer = function(cb) {
	if(!this.did_send) {
		if(!this.originalMsgid) {
			this.originalMsgid = this.msgid;
			this.msgid = this.server.nextMsgid();
		}
		var msg = {
			code: CODE_EMPTY,
			tt: TT_ACK,
			msgid: this.originalMsgid,
			to: this.to,
			from: this.from,
		};
		this.tt = TT_CON;
		this.did_defer = true;
		this.server._sendMessage(msg,cb);
	} else {
		if(typeof cb === 'function')
			cb(new Error('Already sent'));
	}
}

OutboundMessage.prototype.send = function(cb) {
	if(!this.did_send) {
		this.did_send = true;
		this._send(cb);
	} else {
		if(typeof cb === 'function')
			cb(new Error('Already sent'));
	}
}

////////////////////////////////////////////////////////////////////////////////

function OutboundHandler(server, msg, cb) {
	var self = this;

	self.server = server;
	self.msg = msg;
	self.cb = cb;
	self.date_created = Date.now();
	self.retryAttempts = 0;

	if(typeof msg.timeoutPeriod === 'undefined')
		self.timeoutPeriod = 30 * 1000;
	else
		self.timeoutPeriod = msg.timeoutPeriod;

	server.prepareForOutbound(msg, function (err,msg) {
		if(err || self.isFinished) {
			if(typeof self.cb === 'function')
				self.cb(null, err);
			self.cleanup();
		} else {
			self.msg = msg;

			var msgidHash = GenerateMessageHash(self.msg.msgid,self.msg.to);
			var tokenHash = GenerateMessageHash(self.msg.token,self.msg.to);

			self.server.currentConfirmables[msgidHash] = self;
			self.server.currentConfirmables[tokenHash] = self;

			process.nextTick(function () {
				self.retry();
			});
		}
	});

	self.timeoutId = setTimeout(function() {
		if(typeof self.cb === 'function')
			self.cb(null, new Error('Timeout'));
		self.cleanup();
	}, self.timeoutPeriod);
}

OutboundHandler.prototype.retry = function() {
	var self = this;
	self.retryAttempts++;
//	console.log(" ... Retry number " + self.retryAttempts);
	self.server._sendMessage(this.msg, function (err) {
		if(err) {
			if(typeof self.cb === 'function')
				self.cb(null, err);
			self.cleanup();
		} else if (self.msg.tt == TT_CON) {
			var retryPeriod = 1000*self.retryAttempts*self.retryAttempts;
			self.retryId = setTimeout(function () { self.retry(); }, retryPeriod);
		}
	});
}

OutboundHandler.prototype.haltRetransmit = function() {
	if(typeof this.retryId !== 'undefined')
		clearTimeout(this.retryId);
}

OutboundHandler.prototype.cleanup = function() {
//	console.log(" Cleaning up...");
	this.isFinished = true;
	this.haltRetransmit();
	clearTimeout(this.timeoutId);
	delete this.cb;
	delete this.server.currentConfirmables[GenerateMessageHash(this.msg.token,this.msg.to)];
	delete this.server.currentConfirmables[GenerateMessageHash(this.msg.msgid,this.msg.to)];
}

////////////////////////////////////////////////////////////////////////////////

var GenerateMessageHash = function(msgid,addr) {
	var hash = crypto.createHash("sha1");
	hash.update(addr.address + ':' + addr.port + ':' + String(msgid));
	return hash.digest("hex")
}

////////////////////////////////////////////////////////////////////////////////

function Server(requestListener) {
	if (!(this instanceof Server)) return new Server(requestListener);
	EventEmitter.call(this);
	var self = this;

	if (requestListener) {
		this.addListener('request', requestListener);
	}
	this.socket = dgram.createSocket('udp6',function(packet,rinfo) {
		self.handlePacket(packet,rinfo);
	});
	this.socket.bind(DEFAULT_PORT);

	this.recentResponses = {};
	this.currentConfirmables = {};

	this.lastMsgid = 0;
}

util.inherits(Server, EventEmitter);
exports.Server = Server;

Server.prototype.nextMsgid = function () {
	return ++this.lastMsgid;
}

Server.prototype.prepareForOutbound = function (msg, cb) {
	if((msg.content !== undefined) && typeof msg.content != 'Buffer')
		msg.content = Buffer(msg.content);

	if(typeof msg.options === 'undefined')
		msg.options = { };

	if(typeof msg.path === 'string') {
		var path = msg.path;
		if(path.charAt(0) == '/')
			path = path.substring(1);
		msg.options[OPTION_URI_PATH] = path.split("/").map(decodeURIComponent);
	}


	if(typeof msg.to == 'undefined') {
		msg.to = { port: DEFAULT_PORT };
		if(typeof msg.port !== 'undefined') {
			msg.to.port = msg.port;
		}

		if(typeof msg.host !== 'undefined' && !net.isIP(msg.host)) {
			msg.options[OPTION_URI_HOST] = msg.host;

			// Now we need to look up the domain name.
			dns.lookup(msg.host,function (err,address) {
				if(!err || typeof address !== 'undefined') {
					msg.to.address = address;
					cb(null,msg);
				} else {
					cb(err);
				}
			});
		} else {
			cb(new Error('no destination'));
		}
	} else {
		cb(null,msg);
	}
}

Server.prototype._sendMessage = function (msg, cb) {
	var self = this;

	this.prepareForOutbound(msg, function (err,msg) {
		if(msg) {
			console.log(" *** Sending packet.");
			console.log(msg);
			var buffer = CoAPParser.constructPacket(msg);

			if(typeof buffer != 'Buffer')
				buffer = new Buffer(buffer,'binary');

			var to = msg.to;

			self.socket.send(buffer,0,buffer.length,to.port,to.address);
		}

		if(typeof cb === 'function')
			cb(err);
	});
}

Server.prototype.sendRequest = function (msg, cb) {
	var self = this;
	if(msg.tt == TT_CON || codeIsRequest(msg.code)) {
		if(typeof msg.msgid === 'undefined')
			msg.msgid = self.nextMsgid();
		if(typeof msg.token === 'undefined')
			msg.token = Buffer(self.nextMsgid());

		var handler = new OutboundHandler(self,msg,cb);
	} else {
		this._sendMessage(msg, function (err) {
			if(typeof cb === 'function')
				cb(null,err);
		});
	}
}

Server.prototype.handlePacket = function (packet,from,to,info) {
	var msg = CoAPParser.parsePacket(packet);
	msg.to = to;
	msg.from = from;
	msg.info = info;
//	console.log(" *** Got packet. ");
//	console.log(msg);

	if(msg.options[OPTION_URI_PATH])
		msg.path = "/" + msg.options[OPTION_URI_PATH].map(encodeURIComponent).join("/");

	if(msg.options[OPTION_URI_HOST])
		msg.host = msg.options[OPTION_URI_HOST];

	if(msg.options[OPTION_URI_PORT])
		msg.port = msg.options[OPTION_URI_PORT];


	if(codeIsRequest(msg.code)) {
		var msgidHash = GenerateMessageHash(msg.msgid,msg.from);
		var response = this.recentResponses[msgidHash];

		if(response) {
			response._send();
		} else {
			response = new OutboundMessage(this,from,to);

			response.msgid = msg.msgid;
			response.token = msg.token;
			response.tt = TT_ACK;
			response.code = CODE_2_05_CONTENT;

			this.recentResponses[msgidHash] = response;

			this.emit('request', msg, response);

			if(!response.did_send && !response.did_defer) {
				response.defer();
			}
		}
	} else {
		var msgidHash = GenerateMessageHash(msg.msgid,msg.from);
		var tokenHash = GenerateMessageHash(msg.token,msg.from);
		var handler = this.currentConfirmables[msgidHash];

		if(!handler) {
			handler = this.currentConfirmables[tokenHash];
		}

		if(handler) {
//			console.log(" *** Got response for handler");
			if(codeIsRequest(handler.msg.code) && msg.code == CODE_EMPTY && msg.tt == TT_ACK) {
				handler.haltRetransmit();
			} else {
				handler.cb(msg);
				handler.cleanup();
			}
		} else {
			if(msg.tt == TT_RESET) {
				console.log(" *** Unknown reset for msgid "+msg.msgid);
			} else {
				console.log(" *** Unknown response, msgid:"+msg.msgid+" token:"+Buffer(msg.token,'binary'));
			}
		}
	}
}

Server.prototype.destroy = function (error) {
  this.socket.destroy(error);
}









/*






var packet = new Buffer("420174aa73aa3d0d636f6e636f72642e6f72696f6e2e64656570646172632e636f6d88736563757269747903702d31005128",'hex');
var packet_parsed = coap_parser.parsePacket(packet);

console.log(packet_parsed);

var packet_constructed = coap_parser.constructPacket(packet_parsed);

console.log(packet.toString('hex'));
console.log(packet_constructed.toString('hex'));
console.log(packet_constructed == packet);

*/
