# Homebridge Vizio Soundbar

Local Apple Home control for network-connected Vizio SmartCast soundbars, built for Homebridge 2.4 and later. The soundbar is exposed as an external audio receiver with a primary Television service and a linked TelevisionSpeaker service, using Homebridge's current HomeKit definitions and promise-based characteristic handlers.

## Requirements

- Homebridge **2.4.0 or later within 2.x**.
- Node.js **22.13+, 24.x, or 26.x**. Node 24 LTS is a suitable default.
- A Vizio soundbar exposing the SmartCast audio settings API on your local network. Bluetooth-only soundbars are not supported.
- Network access from Homebridge to the soundbar, normally on TCP port 9000. Reserve its IP address in your router.

This release targets the HomeKit services used by current Apple Home/iOS. It does not add AirPlay audio streaming or Matter support. Automated checks use Homebridge 2.4.0 and a simulated HTTPS device; physical soundbar and iPhone compatibility still needs validation on your hardware. Vizio firmware and model differences can affect available commands.

## Install and configure

Install `@jorts/homebridge-vizio-soundbar` through the Homebridge UI. For a local checkout:

```sh
npm ci
npm run check
npm pack
```

Install the resulting package on your Homebridge host using its npm plugin installation workflow. For development on a dedicated test instance, `npm link` makes this checkout available to Homebridge after `npm run build`.

Add one platform entry to your Homebridge configuration:

```json
{
  "platforms": [
    {
      "platform": "HomebridgeVizioSoundbar",
      "name": "Living Room Soundbar",
      "ip": "192.168.1.50"
    }
  ]
}
```

| Setting | Default | Description |
| --- | --- | --- |
| `name` | `Vizio Soundbar` | Accessory name. Keep the configuration name unchanged after pairing; it determines the accessory identity. Rename it in Apple Home instead. |
| `ip` | Required | IP address or hostname, optionally including a port, such as `192.168.1.50:9000`. Omit the URL scheme. Bracket IPv6 addresses, such as `[fd00::1234]:9000`. |
| `authToken` | Unset | Existing SmartCast authentication token, if your model requires one. Token acquisition/pairing with Vizio is outside this plugin. |
| `pollInterval` | `30` | Seconds between background state refreshes: 10–3600, or 0 to disable. Reads requested by HomeKit still query the device directly. |
| `requestTimeout` | `3000` | Per-request timeout in milliseconds, from 500 to 4000. Hash-based read/write commands have a total deadline of twice this value, including queue time. |

After restarting Homebridge, wait for the log message confirming the soundbar was published. In **Apple Home → Add Accessory → More Options**, select the soundbar and use your Homebridge PIN. External receivers are paired separately from the main Homebridge bridge.

The plugin discovers the available inputs before publishing. If the soundbar is unavailable at startup, discovery retries every 30 seconds. Ensure network standby/Wi-Fi remains available when the soundbar is off if you want to turn it on from Home.

## Controls

- Power on/off, current input, input selection, mute, absolute volume, and relative volume buttons.
- Input names and visibility configurable through the Home app's receiver settings. These settings survive Homebridge restarts and do not change the protocol names sent to Vizio.
- Background updates for changes made with the physical remote or Vizio app. Communication failures appear as unavailable characteristics; an unreachable soundbar is not treated as powered off.
- Rewind/fast-forward remote commands using the existing SmartCast key codes. Other remote keys are not advertised. Media command support depends on the soundbar's firmware and selected input.

Apple Home decides which controls it displays for receivers. Not every client exposes an absolute-volume slider; HomeKit clients that support TelevisionSpeaker volume can use the advertised volume characteristic.

The HTTPS client accepts the soundbar's self-signed certificate only within its own connection agent. It does not change Node's global TLS settings. Authentication headers are sent for all requests when configured, and response bodies/tokens are not logged. Use the plugin on a trusted local network.

## Upgrading from 0.0.3

Back up your Homebridge configuration and pairing data, then upgrade Node and Homebridge before installing this release. The old Node 10/Homebridge 1 baseline is no longer supported.

The existing `platform`, `ip`, and `name` options continue to work. The UUID seed is preserved, including for configurations without an explicit name. Keep the original configuration name to retain that identity.

The accessory category changes from generic Speaker to Audio Receiver, with Television marked as primary. Home may cache the old presentation. If the accessory's controls do not refresh after restarting Homebridge and the Home app, remove and pair **only the soundbar** again. There is no need to reset the main bridge.

Input identifiers now use stable, nonzero values derived from each protocol input name instead of array positions. **Reselect inputs in existing scenes and automations after upgrading.** Names/visibility set in the old version were not persisted and may need to be set once more. New settings are saved under `vizio-soundbar/<accessory UUID>.json` in Homebridge's storage directory; include this directory in backups.

The plugin identifier now matches the scoped npm package name, `@jorts/homebridge-vizio-soundbar`. The package name itself has not changed.

## Development and verification

```sh
npm ci
npm run check
npm pack --dry-run
```

`npm run check` runs ESLint, a strict TypeScript build, and Node's test runner. Tests use a loopback HTTPS server with a committed **test-only** self-signed certificate and private key. They never contact a physical soundbar or publish mDNS advertisements. The harness instantiates Homebridge's real API and HAP services; production code uses public Homebridge types and the injected `api.hap` objects, with no Homebridge runtime dependency of its own.

CI runs the checks on Node 22, 24, and 26. `npm run watch` recompiles on changes; restart your dedicated test Homebridge instance to load the compiled output.

Before deploying to your primary Homebridge installation, verify on your device:

1. Start Homebridge with the soundbar online, pair it, and check power, every input, mute, absolute volume, and the remote's volume buttons.
2. Change settings with the physical remote and confirm Home updates within the configured polling interval.
3. Rename/hide an input in Home, restart Homebridge, and confirm the settings remain.
4. Restart Homebridge while the soundbar is unreachable, then restore connectivity and confirm discovery recovers.
5. Check power-on from standby; some soundbars disable their network interface when off.

API references: [Homebridge releases](https://github.com/homebridge/homebridge/releases), [supported Node versions](https://github.com/homebridge/homebridge/wiki/How-To-Update-Node.js), [Homebridge plugin API](https://developers.homebridge.io/), and the [original soundbar protocol implementation](https://github.com/furryaccount/vizio-soundbar/blob/master/index.js).
