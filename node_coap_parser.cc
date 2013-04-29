#include <node.h>
#include <v8.h>
#include "coap.h"

// The 'BUFFER' encoding isn't available in v0.8.18. Since that is
// what I'm using at the moment, this is a quick way to mae things compile.
#define BUFFER		BINARY

using namespace v8;

Local<Object> parsePacket_raw(const char* buffer, size_t packet_size) {
	const struct coap_header_s* header = (const struct coap_header_s*)buffer;
	coap_option_key_t key = COAP_OPTION_ZERO;
	const uint8_t* value;
	size_t value_len;
	const uint8_t* option_ptr = header->token + header->token_len;
	Local<Object> parsed_packet = Object::New();
	Local<Object> options = Object::New();

//	coap_dump_header(
//		stderr,
//		" >>> ",
//		header,
//		packet_size
//	);

	if(packet_size<4) {
		ThrowException(Exception::Error(String::New("Packet Too Small")));
		return Local<Object>();
	}

	if(packet_size>65535) {
		ThrowException(Exception::Error(String::New("Packet Too Big")));
		return Local<Object>();
	}

	if(header->version!=COAP_VERSION) {
		ThrowException(Exception::Error(String::New("Bad CoAP Version")));
		return Local<Object>();
	}

	if(header->token_len>8) {
		ThrowException(Exception::Error(String::New("Bad Token Length")));
		return Local<Object>();
	}

	parsed_packet->Set(String::NewSymbol("code"),Number::New(header->code));
	parsed_packet->Set(String::NewSymbol("tt"),Number::New(header->tt));
	parsed_packet->Set(String::NewSymbol("msgid"),Number::New(header->msg_id));
	parsed_packet->Set(String::NewSymbol("version"),Number::New(header->version));
	parsed_packet->Set(
		String::NewSymbol("token"),
		node::Encode((const void*)(header->token), header->token_len,node::BUFFER)
	);

	for(;option_ptr && (unsigned)(option_ptr-(uint8_t*)header)<packet_size && option_ptr[0]!=0xFF;) {
		option_ptr = coap_decode_option(option_ptr, &key, &value, &value_len);
		if(!option_ptr) {
			ThrowException(Exception::Error(String::New("Bad Option")));
			return Local<Object>();
		}
		if((unsigned)(option_ptr-(uint8_t*)header)>packet_size) {
			ThrowException(Exception::Error(String::New("Option value size too big")));
			return Local<Object>();
		}
		Local<Value> data = node::Encode((const void*)value, value_len,node::BUFFER);
		if(options->Has(key)) {
			if(options->Get(key)->IsArray()) {
				Handle<Array> array = Handle<Array>::Cast(options->Get(key));
				// Append.
				array->Set(array->Length(),data);
			} else {
				Local<Array> array = Array::New(2);
				array->Set(0,options->Get(key));
				array->Set(1,data);
				options->Set(key,array);
			}
		} else {
			options->Set(key,data);
		}
	}
	if((unsigned)(option_ptr-(uint8_t*)header)>packet_size) {
		ThrowException(Exception::Error(String::New("Bad Options")));
		return Local<Object>();
	}
	if((unsigned)(option_ptr-(uint8_t*)header)<packet_size) {
		if(option_ptr && option_ptr[0]==0xFF) {

			parsed_packet->Set(
				String::NewSymbol("content"),
				node::Encode((const void*)(option_ptr+1), packet_size-(option_ptr-(uint8_t*)header)-1,node::BUFFER)
			);

			//fprintf(outstream, "Payload-Size: %ld\n",packet_size-(option_ptr-(uint8_t*)header)-1);
		} else {
			ThrowException(Exception::Error(String::New("Extra Data at end of packet")));
			return Local<Object>();
		}
	}

	parsed_packet->Set(
		String::NewSymbol("options"),
		options
	);

	return parsed_packet;
}



Handle<Value> parsePacket(const Arguments& args) {
	HandleScope scope;
	Local<Object> parsed_packet;

	if (args.Length() < 1) {
		ThrowException(Exception::TypeError(String::New("Wrong number of arguments")));
		return scope.Close(Undefined());
	}
	Local<Value> packet = args[0];
	ssize_t buffer_size = node::DecodeBytes(packet);

	if(buffer_size<=0) {
		ThrowException(Exception::Error(String::New("Bad packet")));
		return scope.Close(Undefined());
	}


	char *buffer = NULL;
	buffer = (char*)malloc(buffer_size);
	if(!buffer) {
		ThrowException(Exception::Error(String::New("Bad Malloc")));
		return scope.Close(Undefined());
	}
	buffer_size = node::DecodeWrite(buffer,buffer_size,packet);

	// Decode here!
	parsed_packet = parsePacket_raw(buffer,buffer_size);

	free(buffer);

	return scope.Close(parsed_packet);
}

Handle<Value> constructPacket(const Arguments& args) {
	HandleScope scope;
	Local<Value> ret;
	if (args.Length() < 1) {
		ThrowException(Exception::TypeError(String::New("Wrong number of arguments")));
		return scope.Close(Undefined());
	}
	Local<Object> parsed_packet = Local<Object>::Cast(args[0]);

	uint8_t buffer[COAP_MAX_MESSAGE_SIZE];
	struct coap_header_s* header = (struct coap_header_s*)buffer;

	header->version = COAP_VERSION;
	header->token_len = 0;
	header->code = 0;
	header->tt = 0;

	if(parsed_packet->Has(String::NewSymbol("tt"))) {
		header->tt = parsed_packet->Get(String::NewSymbol("tt"))->ToInteger()->Value();
	}

	if(parsed_packet->Has(String::NewSymbol("code"))) {
		header->code = parsed_packet->Get(String::NewSymbol("code"))->ToInteger()->Value();
	}

	if(parsed_packet->Has(String::NewSymbol("msgid"))) {
		header->msg_id = parsed_packet->Get(String::NewSymbol("msgid"))->ToInteger()->Value();
	}

	if(parsed_packet->Has(String::NewSymbol("token"))) {
		Local<Value> token = parsed_packet->Get(String::NewSymbol("token"));
		ssize_t len = node::DecodeBytes(token);
		if(len<0 || len>8) {
			ThrowException(Exception::Error(String::New("Bad token")));
			return scope.Close(Undefined());
		}
		header->token_len = (uint8_t)len;
		node::DecodeWrite((char*)header->token,header->token_len,token);
	}

	uint8_t* option_ptr = header->token + header->token_len;
	coap_option_key_t prev_key = COAP_OPTION_ZERO;

	if(parsed_packet->Has(String::NewSymbol("options"))) {
		int i,end;
		Local<Object> options = Local<Object>::Cast(parsed_packet->Get(String::NewSymbol("options")));
		Local<Array> keys = options->GetPropertyNames();
		for(i=0,end=keys->Length();i<end;i++) {
			coap_option_key_t key = (coap_option_key_t)keys->Get(i)->ToInteger()->Value();
			Local<Value> value = options->Get((uint32_t)key);
			if(value->IsArray()) {
				Local<Array> array = Local<Array>::Cast(value);
				int j,endj;
				for(j=0,endj=array->Length();j<end;j++) {
					value = array->Get(j);
					ssize_t len = node::DecodeBytes(value);
					if(len<0 || len>65535) {
						ThrowException(Exception::Error(String::New("Bad option")));
						return scope.Close(Undefined());
					}
					uint8_t value_bytes[len];
					node::DecodeWrite((char*)value_bytes,len,value);
					option_ptr = coap_encode_option(
						option_ptr,
						prev_key,
						key,
						value_bytes,
						len
					);
					prev_key = key;
				}

			} else {
				ssize_t len = node::DecodeBytes(value);
				if(len<0 || len>65535) {
					ThrowException(Exception::Error(String::New("Bad option")));
					return scope.Close(Undefined());
				}
				uint8_t value_bytes[len];
				node::DecodeWrite((char*)value_bytes,len,value);
				option_ptr = coap_encode_option(
					option_ptr,
					prev_key,
					key,
					value_bytes,
					len
				);
				prev_key = key;
			}
		}
	}

	size_t len = option_ptr-(uint8_t*)header;

	if(parsed_packet->Has(String::NewSymbol("content"))) {
		*option_ptr++ = 0xFF;
		len++;
		Local<Value> content = parsed_packet->Get(String::NewSymbol("content"));
		len += node::DecodeWrite((char*)option_ptr,sizeof(buffer)-len,content);
	}

//	coap_dump_header(
//		stderr,
//		" <<< ",
//		header,
//		len
//	);

	if (!coap_verify_packet((const char*)buffer,len)) {
		ThrowException(Exception::Error(String::New("Encoding error, bad packet")));
		return scope.Close(Undefined());
	}

	ret = node::Encode((const void*)buffer, len);

	return scope.Close(ret);
}

extern "C" void init(Handle<Object> target) {
	target->Set(String::NewSymbol("parsePacket"),FunctionTemplate::New(parsePacket)->GetFunction());
	target->Set(String::NewSymbol("constructPacket"),FunctionTemplate::New(constructPacket)->GetFunction());
}

NODE_MODULE(coap_parser, init)
