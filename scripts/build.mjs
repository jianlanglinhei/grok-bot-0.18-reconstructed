import { buildFidelityReconstructedAsar } from "./clean-build.mjs";
import { upstreamVersion } from "./lib/config.mjs";

const result = await buildFidelityReconstructedAsar();
console.log(`Reconstructed ASAR: ${result.builtAsar}`);
console.log(`Renderer mode: checksum-pinned upstream ${upstreamVersion} payload`);
