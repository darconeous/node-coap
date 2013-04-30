
var coap = require('./coap');

function Router() {
	if (!(this instanceof Router)) return new Router();
	var self = this;

	this.resources = { };
}

Router.prototype._listAllResources = function (req,res) {
	if(req.code != coap.CODE_GET) {
		res.code = coap.CODE_4_05_METHOD_NOT_ALLOWED;
		res.content = "Method not allowed";
		res.send();
	} else {
		res.code = coap.CODE_2_05_CONTENT;
		res.content = Object.keys(this.resources).map(function(path){return "<"+path+">";}).join(",");
		res.send();
	}
}

Router.prototype.get = function(path, cb) {
	this.resources[path] = cb;
}

Router.prototype.callbackHandler = function(req, res) {
	var func = this.resources[req.path];

	if(func) {
		func(req,res);
	} else {
		if(req.path == "/.well-known/core"
			|| req.path == "/.well-known/core/"
			|| req.path == "/"
		) {
			this._listAllResources(req,res);
		} else {
			res.code = coap.CODE_4_04_NOT_FOUND;
			res.content = "Not Found";
			res.send();
		}
	}
}

exports.Router = Router;
