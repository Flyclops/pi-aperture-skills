/**
 * pi-aperture-skills: makes the skills Aperture publishes over MCP available
 * as ordinary `/skill:<name>` commands. Aperture's URL comes from the
 * `aperture` server in pi's user-level `mcp.json`.
 */
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerApertureSkills } from "./extension.ts";

export default function (pi: ExtensionAPI) {
	registerApertureSkills(pi, { mcpJsonPath: join(getAgentDir(), "mcp.json") });
}
