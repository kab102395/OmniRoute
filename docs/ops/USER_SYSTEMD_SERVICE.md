---
title: "User systemd service on Linux"
version: 3.8.51
lastUpdated: 2026-10-21
---

# User systemd service on Linux

Praxis is configured to run the local OmniRoute gateway through the Unix
account's systemd user manager. This keeps service control scoped to that
account and avoids sudo or password prompts from Praxis.

## Service configuration

The service unit is installed at
`~/.config/systemd/user/omniroute.service`. The validated-release deployment
uses the release pinned in `WorkingDirectory`, currently
`~/.local/share/omniroute/releases/33ad9883641f65de796ec54bf44b5675e35029e5-uZyMJXG3XGmuFQ9gccYgN/standalone`,
and runs `node dev/run-standalone.mjs`. Its deployment identity file records
the source revision and build identity. The unit retains the existing
production mode, loopback host, ports, startup `/healthz` probe, restart policy,
filesystem protections, and journal logging.
The user manager has no `network-online.target` unit, so the user unit does not
declare a dangling system-manager dependency; the application binds to loopback
and its normal provider retry behavior handles upstream network recovery.

`DATA_DIR` remains `/home/kab/.omniroute`. The system service already ran as
`kab`; moving the service to `kab`'s user manager does not copy, re-encrypt,
or rewrite provider credentials or application data. No provider secrets are
stored in the unit.

The unit starts under `default.target`. Lingering is enabled for `kab` on the
current host, so the user manager persists after logout and starts enabled
units at boot. Check it with:

```sh
loginctl show-user kab -p Linger -p RuntimePath
```

## Unprivileged control

When called from `kab`'s login session, the usual commands work directly:

```sh
systemctl --user status omniroute.service
systemctl --user restart omniroute.service
curl --fail http://127.0.0.1:20128/healthz
```

For Praxis processes started without the login-session bus environment, use
`scripts/runtime/omniroute-userctl`. The helper accepts only a small set of
service actions and the exact unit `omniroute.service`; it derives the current
UID, verifies `/run/user/<uid>` and its bus belong to that UID, and invokes
`/usr/bin/systemctl --user`. It does not invoke the system manager, sudo, or
control any other unit. Praxis's Linux launch path selects this helper. A
process under a different account cannot control `kab`'s user
service through this helper.

The production endpoint remains `http://127.0.0.1:20128`, including
`/healthz` and `/api/v1/models`.

## Cutover and verification

Never start the user unit while the system unit owns port 20128. A safe cutover
checks for active gateway clients, stops the system unit without an
interactive authorization prompt, starts the user unit, and verifies health
and the model catalog. If stopping the system unit is denied, leave the
existing service running and arrange an authorized system-manager stop; do not
kill the process or start a competing instance.

On the current host the user unit is enabled and active after cutover. The
system unit is disabled and not running; its unit and drop-ins remain installed
for administrator-authorized rollback. The user unit passed start, restart,
stop/start, health, catalog, and process-crash recovery checks. Lingering and
the default-target enablement establish boot persistence; the host was not
rebooted as part of verification.

The system unit and its drop-ins remain installed as rollback configuration:

- `/etc/systemd/system/omniroute.service`
- `/etc/systemd/system/omniroute.service.d/10-validated-release.conf`
- `/etc/systemd/system/omniroute.service.d/override.conf`

The system unit is disabled at boot. To roll back, stop the user unit, then
use an authorized system-manager operation to start the existing system unit;
if it is in a failed state, reset only that unit's failure state first. Verify
`/healthz` before returning Praxis traffic. Do not remove the user unit or data
directory during rollback. An old system service image alone is not enough to
roll back if a future release changes persistent data formats.

No reboot is needed to verify persistence: `Linger=yes`, `is-enabled`, and the
user unit's `WantedBy=default.target` establish the configured boot behavior.
An actual reboot is intentionally not part of routine acceptance.
