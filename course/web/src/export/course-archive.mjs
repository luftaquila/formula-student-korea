import JSZip from "jszip";
import { courseDirectionOptions } from "../lib/course-display.mjs";
import { buildRoadEdges } from "../../../lib/road-edges.mjs";
import { buildTrackModel } from "../../../lib/track-build.mjs";
import { buildGuidedTrackModel } from "../../../lib/guided-track-build.mjs";
import { resolveCourseRoute, ROUTE_MODE } from "../../../lib/route-mode.mjs";
import { packTrackEntries, safeTrackName } from "../../../lib/pack-track.mjs";
import { buildEnrichedJSON, buildGuidedEnrichedJSON } from "../../../lib/course-export.mjs";
import { renderTwoPanelPNG } from "./panel-canvas.js";

const EXPORT_DATE = new Date("2020-01-01T00:00:00Z");

function installationReadme(safeName, name) {
  return [
    "Assetto Corsa track installation",
    "",
    "- Extract this download to a temporary folder.",
    `- Open ${safeName}-track.zip inside the extracted folder.`,
    "- Find your Assetto Corsa installation folder (usually Steam/steamapps/common/assettocorsa).",
    "- Extract the track ZIP's content folder into that installation folder. Merge folders when prompted.",
    `- Check that the track files are in content/tracks/${safeName}/ inside the installation folder.`,
    `- Start or restart Assetto Corsa and select \"${name}\" from the track list.`,
    "- The JSON and PNG files are reference data and a preview; they are not required for installation.",
    "",
  ].join("\n");
}

// No network or view state: the caller supplies one course data set. Annotation
// export is an explicit operator-only opt-in; the public default omits the field.
export async function buildCourseArchive({ course, cones, route = { markers: [], steps: [] }, memos = [] }, {
  includeMemos = false, renderPreview = renderTwoPanelPNG,
} = {}) {
  const name = course.name;
  const safeName = safeTrackName(name);
  const resolved = resolveCourseRoute(cones, route.markers, route.steps, {
    step: 1.0, metric: true, fallback: courseDirectionOptions(course, cones),
  });
  const cl = resolved.centerline;
  if (!cl.ok) throw new Error(`중심선 생성 실패: ${cl.reason}`);
  const guided = resolved.mode === ROUTE_MODE.GUIDED;
  const edges = guided ? null : buildRoadEdges(cl);
  const track = guided ? buildGuidedTrackModel(cl, cones, { name: safeName }) : buildTrackModel(cl, edges, { name: safeName });
  const entries = packTrackEntries(cl, edges, track, { name: safeName, uiName: name });
  const trackZip = new JSZip();
  for (const [path, content] of Object.entries(entries)) trackZip.file(path, content, { date: EXPORT_DATE });
  // JSZip auto-creates parent directory entries with today's timestamp even
  // when each file has an explicit date. Normalize those entries as well.
  trackZip.forEach((path, entry) => { entry.date = EXPORT_DATE; });
  const trackBytes = await trackZip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const exportMemos = includeMemos ? memos : [];
  const enriched = guided
    ? buildGuidedEnrichedJSON({ name, cones, memos: exportMemos, route: cl, track })
    : buildEnrichedJSON({ name, cones, memos: exportMemos, cl, edges, track });
  if (!includeMemos) delete enriched.memos;
  const png = guided ? entries[`content/tracks/${safeName}/map.png`]
    : await renderPreview(cl, buildRoadEdges(cl, { extraWidthPerSide: 0 }), { name });
  const outer = new JSZip();
  outer.file(`${safeName}.json`, JSON.stringify(enriched), { date: EXPORT_DATE });
  outer.file(`${safeName}.png`, png instanceof Blob ? new Uint8Array(await png.arrayBuffer()) : png, { date: EXPORT_DATE });
  outer.file(`${safeName}-track.zip`, trackBytes, { date: EXPORT_DATE });
  outer.file("README.txt", installationReadme(safeName, name), { date: EXPORT_DATE });
  return {
    filename: `${safeName}.zip`,
    bytes: await outer.generateAsync({ type: "uint8array", compression: "DEFLATE" }),
  };
}

export function downloadCourseArchive({ filename, bytes }) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
