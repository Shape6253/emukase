export type Abi = "arm64-v8a" | "armeabi-v7a" | "x86_64" | "x86";

export function selectAbi(abis: string[]): Abi {
  for (const abi of abis) {
    if (["arm64-v8a", "armeabi-v7a", "x86_64", "x86"].includes(abi)) {
      return abi as Abi;
    }
  }
  throw new Error(`Architecture is not supported yet: ${abis.join(", ") || "not detected"}`);
}
