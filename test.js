
var coap = require('./coap');
var app = require('./testrouter').Router();


var server = new coap.Server(function (req,res) {
	console.log("Got request! ");
	console.log(req);

	app.callbackHandler(req,res);
});

app.get("/one",function (req,res) {
	res.code = coap.CODE_2_05_CONTENT;
	res.content = "ONE!!!";
	res.send();
});

app.get("/two",function (req,res) {
	res.code = coap.CODE_2_05_CONTENT;
	res.content = "TWO!!!";
	res.send();
});

console.log("Server running.");

server.sendRequest({
	code: coap.CODE_GET,
	tt: coap.TT_CON,
	path: "/.well-known/core/",
	host: "concord.orion.deepdarc.com"
}, function(msg, err) {
	if(!err) {
		console.log("Got Response:");
		console.log(msg);
	} else {
		console.log("Error from request: " + err);
	}
});


/*
var coap_parser = require('./build/Release/coap_parser');

var packet = new Buffer("420174aa73aa3d0d636f6e636f72642e6f72696f6e2e64656570646172632e636f6d88736563757269747903702d31005128",'hex');
var packet_parsed = coap_parser.parsePacket(packet);

console.log(packet_parsed);

var packet_constructed = coap_parser.constructPacket(packet_parsed);

console.log(packet.toString('hex'));
console.log(packet_constructed.toString('hex'));
console.log(packet_constructed == packet);
*/

