import { xxhash128 } from "hash-wasm";

/** rmw_zenoh hashes the FULL liveliness token with XXH3-128, then copies low64 and high64
 *  in native byte order. Fleet x86/ARM targets are little-endian; canonical hash hex is reversed.
 *  https://github.com/ros2/rmw_zenoh/blob/rolling/rmw_zenoh_cpp/src/detail/liveliness_utils.cpp
 */
export async function publisherGid(keyexpr: string): Promise<string> {
  return (await xxhash128(keyexpr)).match(/../g)!.reverse().join("");
}
