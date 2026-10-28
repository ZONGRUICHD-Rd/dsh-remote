# dsh-remote-bridge

DSH plugin (Cordis bundle) that serves the DSH Remote iOS app. See the [project README](../README.md).

```bash
dsh plugin --profile desktop add ./dsh-remote-bridge-<version>.tgz   # DSH Desktop
dsh plugin --profile web add ./dsh-remote-bridge-<version>.tgz       # npm `dsh web`
```

Then type `/remote` in DSH. Config (`cordis.patch.yml`): `port` (39090), `adminPort` (39091),
`bindHost` (0.0.0.0), `tls` (true), `mdns` (true), `name`, `stateDir` (`$DSH_HOME/dsh-remote`).
