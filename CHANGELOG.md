# Changelog

## 0.1.0

### Compatibility

- Target Homebridge 2.4+ and Node 22.13/24/26; publish native ESM with a default initializer.
- Register and publish using the actual scoped npm package name.
- Use current Homebridge HAP services and async `onGet`/`onSet` handlers.
- Publish an Audio Receiver with a primary Television service and linked speaker/inputs.

### Fixes

- Wait for input discovery before publishing; recover from startup discovery failures without unhandled rejections.
- Replace the abandoned GitHub SmartCast dependency and its deprecated HTTP stack with a typed, dependency-free HTTPS client using the same audio settings endpoints and key commands.
- Await every write and propagate HTTP, network, device-status, and malformed-response errors to HomeKit.
- Enforce deadlines for stalled connections and queued commands; bound response sizes and abort requests on shutdown.
- Serialize write operations and preserve fresh HASHVAL values for absolute volume and input changes.
- Validate configuration and returned power, mute, volume, input names, and identifiers instead of silently accepting invalid values.
- Use stable nonzero input identifiers; match canonical protocol names before display aliases.
- Persist Home app accessory/input names and visibility with atomic writes.
- Refresh state after physical remote changes; synchronize speaker power and suppress snapshots made stale by HomeKit writes.
- Advertise only implemented remote commands instead of silently succeeding for every key.
- Preserve the original accessory UUID seed and remove placeholder network defaults from the configuration UI.

### Maintenance

- Enable strict TypeScript checks, modern ESLint configuration, loopback HTTPS/HAP regression tests, and CI for supported Node versions.
- Regenerate the lockfile and explicitly include compiled output in the npm package. The old npmignore excluded `dist`, making published packages unusable.
- Replace the template README with setup, migration, behavior, and hardware-verification instructions.

### Migration

Existing input identifiers change. Reselect inputs in Home scenes/automations. Keep the original configuration name to preserve the accessory UUID. Home may require re-pairing the soundbar to refresh its cached accessory category. See README for details.
