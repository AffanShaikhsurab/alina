#!/usr/bin/env node
// LifeOS: turns Rakazo's mobile app.json into Alina's, for CI builds of our own iOS app.
//
//   node scripts/alina-config.mjs            # patches ./app.json in place
//   node scripts/alina-config.mjs --check    # prints the result, writes nothing
//
// Why each change exists:
// - `updates.url` / `extra.eas` / `owner` point at Rakazo's Expo project. Left in, the app would
//   download Rakazo's over-the-air JavaScript on launch and replace our fork's changes.
// - `ios.bundleIdentifier` must be our own; com.rakazo.app belongs to the upstream project.
// - Permission strings say "Alina" instead of "Rakazo".
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appJsonPath = resolve(here, "..", "app.json");
const checkOnly = process.argv.includes("--check");

const bundleId = process.env.ALINA_BUNDLE_ID ?? "com.affanshaikhsurab.alina";
if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(bundleId)) {
  console.error(`ALINA_BUNDLE_ID is not a valid bundle identifier: ${bundleId}`);
  process.exit(1);
}

/** Replace the product name in user-facing sentences only ("Rakazo uses the microphone ..."). */
function rename(value) {
  if (typeof value === "string")
    return value.replace(/\bRakazo\b(?= (uses|turns|connects))/g, "Alina");
  if (Array.isArray(value)) return value.map(rename);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rename(v)]));
  }
  return value;
}

const original = JSON.parse(readFileSync(appJsonPath, "utf8"));
const expo = rename(original.expo);

expo.name = "Alina";
expo.slug = "alina";
// Keep the URL scheme: sign-in redirects and deep links in the app and servers use it.
delete expo.owner;
if (expo.extra) delete expo.extra.eas;
// No OTA: this build must run the JavaScript it was built with.
expo.updates = { enabled: false, checkAutomatically: "NEVER" };
expo.ios = { ...expo.ios, bundleIdentifier: bundleId };
expo.android = { ...expo.android, package: bundleId };

const patched = { ...original, expo };
const text = `${JSON.stringify(patched, null, 2)}\n`;

if (checkOnly) {
  const summary = {
    name: expo.name,
    slug: expo.slug,
    owner: expo.owner ?? null,
    eas: expo.extra?.eas ?? null,
    updates: expo.updates,
    iosBundleIdentifier: expo.ios.bundleIdentifier,
    scheme: expo.scheme,
    version: expo.version,
  };
  console.log(JSON.stringify(summary, null, 2));
} else {
  writeFileSync(appJsonPath, text);
  console.log(`patched ${appJsonPath} for ${bundleId}`);
}
