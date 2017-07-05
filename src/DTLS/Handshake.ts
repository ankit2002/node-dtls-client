﻿import * as TypeSpecs from "../TLS/TypeSpecs";
import { TLSStruct } from "../TLS/TLSStruct";
import { extend } from "../lib/object-polyfill";
import { Random } from "../TLS/Random";
import { SessionID } from "../TLS/SessionID";
import { Cookie } from "./Cookie";
import { CipherSuite } from "../TLS/CipherSuite";
import { CompressionMethod } from "../TLS/ConnectionState";
import { ProtocolVersion } from "../TLS/ProtocolVersion";
import { Extension } from "../TLS/Extension";
import { Vector } from "../TLS/Vector";
import { RecordLayer } from "./RecordLayer";

export enum HandshakeType {
	hello_request = 0,
	client_hello = 1,
	server_hello = 2,
	hello_verify_request = 3,
	certificate = 11,
	server_key_exchange = 12,
	certificate_request = 13,
	server_hello_done = 14,
	certificate_verify = 15,
	client_key_exchange = 16,
	finished = 20
}

export abstract class Handshake extends TLSStruct {
	
	constructor(
		public msg_type: HandshakeType,
		bodySpec: TypeSpecs.StructSpec,
		initial?: any
	) {
		super(bodySpec, initial);
	}

	public message_seq: number;
	
	/**
	 * Fragments this packet into a series of packets according to the configured MTU
	 * @returns An array of fragmented handshake messages - or a single one if it is small enough.
	 */
	fragmentMessage(): FragmentedHandshake[] {
		
		// spec only contains the body, so serialize() will only return that
		const wholeMessage : Buffer = this.serialize();
		let start = 0;
		let fragments: FragmentedHandshake[] = [];
		const maxFragmentLength = RecordLayer.MAX_PAYLOAD_SIZE - FragmentedHandshake.headerLength;
		// loop through the message and fragment it
		while (!fragments.length && start < wholeMessage.length) {
			// calculate maximum length, limited by MTU - IP/UDP headers - handshake overhead
			let fragmentLength = Math.min(maxFragmentLength, wholeMessage.length - start);
			// slice and dice
			const fragment = wholeMessage.slice(start, start + fragmentLength);
			//create the message
			fragments.push(new FragmentedHandshake(
				this.msg_type,
				wholeMessage.length,
				this.message_seq,
				start,
				fragment
			));
			// step forward by the actual fragment length
			start += fragment.length;
		}
		
		return fragments;
	}
	
	/**
	 * Parses a re-assembled handshake message into the correct object struture
	 * @param assembled - the re-assembled (or never-fragmented) message
	 */
	static parse(assembled: FragmentedHandshake) : Handshake {
		if (assembled.isFragmented())
			throw new Error("the message to be parsed MUST NOT be fragmented");
		
		if (HandshakeMessages[assembled.msg_type] != undefined) {
			// find the right type for the body object
			const msgClass = HandshakeMessages[assembled.msg_type];
			// extract the struct spec
			const __spec = msgClass.__spec; // we can expect this to exist
			// turn it into the correct type
			const spec = TypeSpecs.define.Struct(__spec);
			// parse the body object into a new Handshake instance
			const ret = TLSStruct.from(
				spec,
				assembled.fragment
				).result as Handshake;
			ret.message_seq = assembled.message_seq;
			return ret;
		} else {
			throw new Error(`unsupported message type ${assembled.msg_type}`);
		}
	}
	
}

export class FragmentedHandshake extends TLSStruct {

	static readonly __spec = {
		msg_type: TypeSpecs.define.Enum("uint8", HandshakeType),
		total_length: TypeSpecs.uint24,
		message_seq: TypeSpecs.uint16,
		fragment_offset: TypeSpecs.uint24,
		// uint24 fragment_length is implied in the variable size vector
		fragment: TypeSpecs.define.Buffer(0, 2**24-1)
	}
	static readonly spec = TypeSpecs.define.Struct(FragmentedHandshake.__spec);
	/**
	 * The amount of data consumed by a handshake message header (without the actual fragment)
	 */
	static readonly headerLength = 1+3+2+3+3; // TODO: dynamisch?
	
	constructor(
		public msg_type: HandshakeType,
		public total_length: number,
		public message_seq: number,
		public fragment_offset: number,
		public fragment: Buffer
	) {
		super(FragmentedHandshake.__spec);
	}
	
	static createEmpty(): FragmentedHandshake {
		return new FragmentedHandshake(null, null, null, null, null);
	}
	
	/**
	 * Checks if this message is actually fragmented, i.e. total_length > fragment_length
	 */
	isFragmented(): boolean {
		return (this.fragment_offset !== 0) || (this.total_length > this.fragment.length);
	}
	
	/**
	 * Enforces an array of fragments to belong to a single message
	 * @throws Error
	 */
	// TODO: error Documentation
	private static enforceSingleMessage(fragments: FragmentedHandshake[]): void {
		// check if we are looking at a single message, i.e. compare type, seq_num and length
		const singleMessage = fragments.every((val, i, arr) => {
			if (i > 0) {
				return val.msg_type === arr[0].msg_type &&
					val.message_seq === arr[0].message_seq &&
					val.total_length === arr[0].total_length
					;
			}
			return true;
		});
		if (!singleMessage) 
			throw new Error('this series of fragments belongs to multiple messages'); // TODO: better type?		
	}

	/**
	 * In the given array of fragments, find all that belong to the reference fragment
	 * @param fragments - Array of fragments to be searched
	 * @param reference - The reference fragment whose siblings should be found
	 */
	static findAllFragments(fragments: FragmentedHandshake[], reference: FragmentedHandshake): FragmentedHandshake[] {
		// ignore empty arrays
		if (!(fragments && fragments.length)) return [];

		// return all fragments with matching msg_type, message_seq and total length
		return fragments.filter(f => {
			return f.msg_type === reference.msg_type &&
				f.message_seq === reference.message_seq &&
				f.total_length === reference.total_length
				;
		});
	}
	
	/**
	 * Checks if the provided handshake fragments form a complete message
	 */
	static isComplete(fragments : FragmentedHandshake[]): boolean {
		// ignore empty arrays
		if (!(fragments && fragments.length)) return false;
		FragmentedHandshake.enforceSingleMessage(fragments);

		const firstSeqNum = fragments[0].message_seq;
		const totalLength = fragments[0].total_length;
		const ranges = fragments
			// map to fragment range (start and end index)
			.map(f => ({start: f.fragment_offset, end: f.fragment_offset + f.fragment.length-1}))
			// order the fragments by fragment offset
			.sort((a,b) => a.start - b.start)
			;
		// check if the fragments have no holes
		const noHoles = ranges.every((val, i, arr) => {
			if (i === 0) {
				// first fragment should start at 0
				if (val.start !== 0) return false; 
			} else {
				// every other fragment should touch or overlap the previous one
				if (val.start - arr[i-1].end > 1) return false;
			}
			// last fragment should end at totalLength-1
			if (i === arr.length-1) {if (val.end !== totalLength-1) return false; }
			// no problems
			return true;
		});
		
		return noHoles;
	}
	
	/**
	 * Reassembles a series of fragmented handshake messages into a complete one.
	 * Warning: doesn't check for validity, do that in advance!
	 */
	static reassemble(messages : FragmentedHandshake[]) : FragmentedHandshake {
		// cannot reassemble empty arrays
		if (!(messages && messages.length)) 
			throw new Error("cannot reassemble handshake from empty array"); // TODO: Better type?
		
		// sort by fragment start
		messages = messages.sort((a,b) => a.fragment_offset - b.fragment_offset);
		// combine into a single buffer
		const combined = Buffer.allocUnsafe(messages[0].total_length);
		for (let msg of messages) {
			msg.fragment.copy(combined, msg.fragment_offset);
		}
		
		// and return the complete message
		return new FragmentedHandshake(
			messages[0].msg_type,
			messages[0].total_length,
			messages[0].message_seq,
			0,
			combined
		);
	}
	
}



// Handshake message implementations
export class HelloRequest extends Handshake {

	static readonly __spec = {}

	constructor() {
		super(HandshakeType.hello_request, HelloRequest.__spec);
	}

	static createEmpty(): HelloRequest {
		return new HelloRequest();
	}
}

export class ClientHello extends Handshake {

	static readonly __spec = {
		client_version: TypeSpecs.define.Struct(ProtocolVersion),
		random: TypeSpecs.define.Struct(Random),
		session_id: SessionID.spec,
		cookie: Cookie.spec,
		cipher_suites: TypeSpecs.define.Vector(CipherSuite.__spec.id, 2, 2 ** 16 - 2),
		compression_methods: TypeSpecs.define.Vector(CompressionMethod.spec, 1, 2 ** 8 - 1),
		extensions: TypeSpecs.define.Vector(Extension.spec, 0, 2 ** 16 - 1, true),
	}


	constructor(
		public client_version: ProtocolVersion,
		public random: Random,
		public session_id: Buffer,
		public cookie: Buffer,
		public cipher_suites: Vector<number>,
		public compression_methods: Vector<CompressionMethod>,
		public extensions: Vector<Extension>
	) {
		super(HandshakeType.client_hello, ClientHello.__spec);
	}

	static createEmpty(): ClientHello {
		return new ClientHello(null, null, null, null, null, null, null);
	}
}

export class ServerHello extends Handshake {

	static readonly __spec = {
		server_version: TypeSpecs.define.Struct(ProtocolVersion),
		random: TypeSpecs.define.Struct(Random),
		session_id: SessionID.spec,
		cipher_suite: CipherSuite.__spec.id,//TypeSpecs.define.Struct(CipherSuite),
		compression_method: CompressionMethod.spec,
		extensions: TypeSpecs.define.Vector(Extension.spec, 0, 2 ** 16 - 1, true),
	}

	constructor(
		public server_version: ProtocolVersion,
		public random: Random,
		public session_id: Buffer,
		public cipher_suite: number,
		public compression_method: CompressionMethod,
		public extensions: Vector<Extension>
	) {
		super(HandshakeType.server_hello, ServerHello.__spec);
	}

	static createEmpty(): ServerHello {
		return new ServerHello(null, null, null, null, null, null);
	}
}

export class HelloVerifyRequest extends Handshake {

	static readonly __spec = {
		server_version: TypeSpecs.define.Struct(ProtocolVersion),
		cookie: Cookie.spec
	}

	constructor(
		public server_version: ProtocolVersion,
		public cookie: Buffer
	) {
		super(HandshakeType.hello_verify_request, HelloVerifyRequest.__spec);
	}

	static createEmpty(): HelloVerifyRequest {
		return new HelloVerifyRequest(null, null);
	}
}


export class ServerKeyExchange extends Handshake {

	static readonly __spec = {
		raw_data: TypeSpecs.define.Buffer() // the entire fragment
	}

	//static readonly __specs: {
	//	[algorithm in KeyExchangeAlgorithm]?: TypeSpecs.StructSpec
	//} = {
	//	psk: {
	//		psk_identity_hint: TypeSpecs.define.Vector(TypeSpecs.uint8, 0, 2 ** 16 - 1)
	//	}
	//}

	public raw_data: Buffer;

	constructor() {
		super(HandshakeType.server_key_exchange, ServerKeyExchange.__spec);
	}

	static createEmpty(): ServerKeyExchange {
		return new ServerKeyExchange();
	}
}

export class ServerKeyExchange_PSK extends TLSStruct {

	static readonly __spec = {
		psk_identity_hint: TypeSpecs.define.Buffer(0, 2 ** 16 - 1)
	};
	static readonly spec = TypeSpecs.define.Struct(ServerKeyExchange_PSK);

	constructor(
		public psk_identity_hint: Buffer
	) {
		super(ServerKeyExchange_PSK.__spec);
	}

	static createEmpty(): ServerKeyExchange_PSK {
		return new ServerKeyExchange_PSK(null);
	}

}


export class ClientKeyExchange extends Handshake {

	//static readonly __specs: {
	//	[algorithm in KeyExchangeAlgorithm]?: TypeSpecs.StructSpec
	//} = {
	//	psk: {
	//		psk_identity: TypeSpecs.define.Buffer(0, 2 ** 16 - 1)
	//	}
	//}

	static readonly __spec = {
		raw_data: TypeSpecs.define.Buffer() // the entire fragment
	}

	public raw_data: Buffer;

	constructor() {
		super(HandshakeType.client_key_exchange, ClientKeyExchange.__spec);
	}

	static createEmpty(): ClientKeyExchange {
		return new ClientKeyExchange();
	}
}

export class ClientKeyExchange_PSK extends TLSStruct {

	static readonly __spec = {
		psk_identity: TypeSpecs.define.Buffer(0, 2 ** 16 - 1)
	};
	static readonly spec = TypeSpecs.define.Struct(ClientKeyExchange_PSK);

	constructor(
		public psk_identity: Buffer
	) {
		super(ClientKeyExchange_PSK.__spec);
	}

	static createEmpty(): ClientKeyExchange_PSK {
		return new ClientKeyExchange_PSK(null);
	}

}


export class ServerHelloDone extends Handshake {

	static readonly __spec = {}

	constructor() {
		super(HandshakeType.server_hello_done, ServerHelloDone.__spec);
	}

	static createEmpty(): ServerHelloDone {
		return new ServerHelloDone();
	}
}


export class Finished extends Handshake {

	static readonly __spec = {
		verify_data: TypeSpecs.define.Buffer() // full-length
	}

	constructor(
		public verify_data: Buffer
	) {
		super(HandshakeType.finished, Finished.__spec);
	}

	static createEmpty(): Finished {
		return new Finished(null);
	}
}

// define handshake messages for lookup
export const HandshakeMessages: {
	[type: number]: {__spec: any}
} = {};
HandshakeMessages[HandshakeType.hello_request] = HelloRequest;
HandshakeMessages[HandshakeType.client_hello] = ClientHello;
HandshakeMessages[HandshakeType.server_hello] = ServerHello;
HandshakeMessages[HandshakeType.hello_verify_request] = HelloVerifyRequest;
HandshakeMessages[HandshakeType.server_hello_done] = ServerHelloDone;
HandshakeMessages[HandshakeType.finished] = Finished;
