// Pushes each Workflow Decaid sends plugins in a `workflowUpdated` event, as
// sent, on this plugin's `workflow` socket, so record.mjs can keep it beside
// what `GET /workflow` answers. Installed only into the throwaway Decaid the
// fixtures were recorded on.
function createPlugin(host) {
  return {
    id: "workflow-recorder.reaplugin",
    version: "0.0.1",
    onLoad() {},
    onUnload() {},
    onEvent(event) {
      if (event.name === "workflowUpdated") host.emit("workflow", { workflow: event.payload });
    },
  };
}
