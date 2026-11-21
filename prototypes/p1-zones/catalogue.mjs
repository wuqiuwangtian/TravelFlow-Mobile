// Host candidate: the pinned catalogue supplies names; Intl supplies the rules.
import catalogue from "./catalogue.json" with { type: "json" };
import { require } from "../p1-boundary/input.mjs";

export const ZONE_CATALOGUE_ID = `iana-${catalogue.release}-main-backward-1`;
const names = new Map(catalogue.zones.map(zone => [zone, zone]));
for (const [alias, target] of Object.entries(catalogue.links)) names.set(alias, target);

let localCapability;
export function zoneCapability() {
  if (localCapability) return localCapability;
  const unavailable = new Set(["Factory"]); // Unspecified local time (-00).
  for (const zone of catalogue.zones) {
    if (unavailable.has(zone)) continue;
    try { new Intl.DateTimeFormat("en", { timeZone: zone }); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
      unavailable.add(zone);
    }
  }
  localCapability = Object.freeze({
    zone_catalogue_id: ZONE_CATALOGUE_ID, tzdata_version: process.versions.tz ?? null,
    provider: "node-intl", icu: process.versions.icu, zones: catalogue.zones.length,
    links: Object.keys(catalogue.links).length,
    unavailable_targets: Object.freeze([...unavailable].sort()),
  });
  return localCapability;
}

// Used for a new booking after receipt lookup, and for a prospective peer
// capability check. Return the target for calculation only; keep input intact.
export function bookingZone(name, basis, capability = zoneCapability()) {
  require(basis.zone_catalogue_id === ZONE_CATALOGUE_ID && capability?.zone_catalogue_id === ZONE_CATALOGUE_ID
    && typeof capability.tzdata_version === "string" && /^[0-9]{4}[a-z]+$/.test(capability.tzdata_version)
    && basis.tzdata_version === capability.tzdata_version, "resolution_basis");
  const target = names.get(name);
  require(target !== undefined, "zone");
  require(target !== "Factory" && Array.isArray(capability.unavailable_targets)
    && !capability.unavailable_targets.includes(target), "zone_unavailable");
  return target;
}
