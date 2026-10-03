# Machine identity is the hardware: model plus serial

A machine is identified by its model and serial number, not by the tablet attached to it or the connection id Decaid uses for it. Replacing a tablet doesn't create a new machine, and moving a tablet to another machine doesn't move its shot history with it. Each shot is credited to the machine whose model and serial it recorded at the time, and shots are stored once by shot id, not under the machine whose tablet happened to report them.

The prototype used `de1-<BLE MAC>` of Decaid's preferred machine, which breaks in three ways: over USB the preferred id is a USB device id, a replaced Bluetooth board changes the MAC, and a tablet moved to another machine would refile its whole history under the new one.

## Consequences

- Older DE1s report serial `"0"` unless Decaid can resolve it through the owner's Decent account. A machine that connects without a real serial is **unidentified** until someone links it to a machine in the management interface. The server then remembers its connection id (BLE MAC or USB id) as an alias.
- Shots imported from the legacy Tcl app (`de1app-*`) carry no machine information. They are credited to the machine whose tablet reported them, and marked as inferred.
- **Adoption is manual and tokens belong to machines.** An admin creates a machine entry (optionally with its location) in the management interface, which issues a token. Someone enters the server URL and token in the plugin's settings. Nothing joins automatically. The first connection binds the token to the model and serial it reports. A later connection with that token but a different serial (for example a tablet moved to another machine) is accepted in a mismatch state: the server stores what it sends but shares nothing to it until an admin issues a token for the new machine or rejects it.
