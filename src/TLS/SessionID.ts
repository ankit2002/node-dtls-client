﻿import * as TypeSpecs from "./TypeSpecs";
import { TLSStruct } from "./TLSStruct";
import { Vector } from "../TLS/Vector";

export namespace SessionID {

	export const spec = TypeSpecs.define.Buffer(0, 32);

	//export function createNew(data: Buffer) {
	//	return new Vector<number>(items);
	//}

}