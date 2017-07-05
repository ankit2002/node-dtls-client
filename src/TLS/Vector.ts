﻿import * as TypeSpecs from "./TypeSpecs";
import { ISerializable, ISerializableConstructor, DeserializationResult } from "./Serializable";
import { TLSStruct } from "./TLSStruct";
import { fitToWholeBytes } from "../lib/util";
import { BitSizes, numberToBuffer, bufferToNumber, bufferToByteArray } from "../lib/BitConverter";

export class Vector<T extends number | ISerializable> {

	// TODO: this has to be possible without the spec param
	// maybe pass it when serializing?
	constructor(
		//public spec: TypeSpecs.Vector, 
		public items: T[] = []
	) { }

	serialize(spec: TypeSpecs.Vector): Buffer {
		// optional, empty vectors resolve to empty buffers
		if (this.items.length === 0 && spec.optional) {
			return Buffer.allocUnsafe(0);
		}
		// serialize all the items into single buffers
		let
			serializedItems: Buffer[],
			bitSize: BitSizes;
			;
		switch (spec.itemSpec.type) {
			case "number":
			case "enum":
				bitSize = TypeSpecs.getPrimitiveSize(spec.itemSpec) as BitSizes;
				//+(spec.itemSpec as (TypeSpecs.Number | TypeSpecs.Enum)).size.substr("uint".length) as BitSizes;
				serializedItems = (this.items as number[]).map(v => numberToBuffer(v, bitSize));
				break;

			case "struct":
				serializedItems = (this.items as ISerializable[]).map(v => v.serialize());
			}
		let ret = Buffer.concat(serializedItems);
		// for variable length vectors, prepend the maximum length
		if (TypeSpecs.Vector.isVariableLength(spec)) {
			const lengthBits = (8 * fitToWholeBytes(spec.maxLength)) as BitSizes;
			ret = Buffer.concat([
				numberToBuffer(ret.length, lengthBits),
				ret
			]);
		}
		return ret;

	}
	private deserialize(spec: TypeSpecs.Vector, buf: Buffer, offset = 0): number {
		// for variable length vectors, read the length first
		let length = spec.maxLength;
		let delta = 0;
		if (TypeSpecs.Vector.isVariableLength(spec)) {
			const lengthBits = (8 * fitToWholeBytes(spec.maxLength)) as BitSizes;
			length = bufferToNumber(buf, lengthBits, offset);
			delta += lengthBits / 8;
		}
		switch (spec.itemSpec.type) {
			case "number":
			case "enum":
				const bitSize = TypeSpecs.getPrimitiveSize(spec.itemSpec) as BitSizes;
				for (let i = 0; i < length; i += bitSize / 8) {
					this.items.push(bufferToNumber(buf, bitSize, offset + delta) as any as T); // we know this is a number!
					delta += bitSize / 8;
				}
				break;
			case "struct":
				let i = 0;
				while (i < length) {
					let item = spec.itemSpec.structType.from(spec.itemSpec, buf, offset + delta);
					i += item.readBytes;
					delta += item.readBytes;
					this.items.push(item.result as any as T); // we know this is a struct/ISerializable
				}
		}
		return delta;
	}

	static from<T extends number | ISerializable>(spec: TypeSpecs.Vector, buf: Buffer, offset?: number): DeserializationResult<Vector<T>> {
		const ret = new Vector<T>();
		if (buf.length === 0) {
			if (spec.optional) return { result: ret, readBytes: 0 };
			throw new Error("nothing to deserialize");
		} else {
			return { result: ret, readBytes: ret.deserialize(spec, buf, offset) };
		}
	}

	//static createFromBuffer(buf: Buffer) {
	//	return new Vector<number>(bufferToByteArray(buf));
	//}

	/*static isVariableLength(spec: TypeSpecs.Vector): boolean {
		return spec.maxLength !== spec.minLength;
	}*/

}