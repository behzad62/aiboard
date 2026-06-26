import {
  capabilityProbeCapabilities,
  evaluateMarkerProbeResult,
  evaluateParameterAcceptanceProbeResult,
} from "../lib/client/capability-api";
import { PROBE_IMAGE_ATTACHMENT } from "../lib/providers/capability-probes";

function check(name: string, condition: boolean, detail?: string) {
  if (!condition) {
    console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS - ${name}`);
}

const emptySuccessfulOutput = { text: "", chunks: 0 };
const markerMissingOutput = { text: "not the requested marker", chunks: 1 };
const markerOutput = { text: "prefix AIBOARD_TEXT_OK suffix", chunks: 1 };

const markerPass = evaluateMarkerProbeResult({
  id: "text",
  output: markerOutput,
  marker: "AIBOARD_TEXT_OK",
  passDetail: "Text prompt passed",
  failDetail: "Expected exact marker was not returned",
});
check("marker probe passes when marker is present", markerPass.status === "pass");

const markerFail = evaluateMarkerProbeResult({
  id: "text",
  output: markerMissingOutput,
  marker: "AIBOARD_TEXT_OK",
  passDetail: "Text prompt passed",
  failDetail: "Expected exact marker was not returned",
});
check("marker probe still fails when marker is missing", markerFail.status === "fail");

const temperatureResult = evaluateParameterAcceptanceProbeResult({
  id: "temperature",
  output: emptySuccessfulOutput,
  marker: "AIBOARD_TEMPERATURE_OK",
  passDetail: "Temperature parameter was accepted",
  acceptedWithoutMarkerDetail:
    "Temperature request succeeded but marker was missing",
});
check(
  "temperature probe passes when provider accepted the parameter but visible marker is empty",
  temperatureResult.status === "pass",
  temperatureResult.detail
);

const maxTokenResult = evaluateParameterAcceptanceProbeResult({
  id: "maxTokens",
  output: emptySuccessfulOutput,
  marker: /^OK$/i,
  passDetail: "Max-token parameter was accepted",
  acceptedWithoutMarkerDetail:
    "Small max-token request succeeded but expected reply was missing",
});
check(
  "max-token probe passes when provider accepted the cap but hidden reasoning consumed visible output",
  maxTokenResult.status === "pass",
  maxTokenResult.detail
);

const imageProbeCaps = capabilityProbeCapabilities(
  { image: false, document: false, audio: false, video: false },
  "imageInput"
);
check("image probe forces actual image transport instead of relying on static catalog caps", imageProbeCaps.image);
check(
  "image probe filename does not leak the expected answer",
  !/red/i.test(PROBE_IMAGE_ATTACHMENT.filename),
  PROBE_IMAGE_ATTACHMENT.filename
);
