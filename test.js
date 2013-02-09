var coap_parser = require('./build/Release/coap_parser');

var packet = new Buffer("420174aa73aa3d0d636f6e636f72642e6f72696f6e2e64656570646172632e636f6d88736563757269747903702d31005128",'hex');
var packet_parsed = coap_parser.parsePacket(packet);

console.log(packet_parsed);

var packet_constructed = coap_parser.constructPacket(packet_parsed);

console.log(packet.toString('hex'));
console.log(packet_constructed.toString('hex'));
console.log(packet_constructed == packet);

