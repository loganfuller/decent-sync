// A plugin that makes the `host.notify` and `host.dismissNotification` calls it is asked to, one after another, then
// waits a moment and answers with what each call returned or threw and every event delivered to it since the request
// began (README.md beside record.mjs). Installed on a throwaway Decaid only.
function createPlugin(host) {
  let events = [];
  let loads = 0;
  return {
    id: "notice-probe.reaplugin",
    version: "0.0.1",
    onLoad(settings) {
      loads += 1;
      host.log("notice probe loaded with " + JSON.stringify(settings || {}));
    },
    onUnload() {},
    onEvent(event) {
      events.push(event);
    },
    __httpRequestHandler: async (request) => {
      const calls = (request.body && request.body.calls) || [];
      const waitMs = (request.body && request.body.waitMs) || 1500;
      events = [];
      const answers = [];
      for (const call of calls) {
        try {
          if (call.op === "notify") answers.push({ returned: host.notify(call.notice) });
          else if (call.op === "dismiss") answers.push({ returned: call.id === undefined ? host.dismissNotification() : host.dismissNotification(call.id) });
          else answers.push({ unknownOp: call.op });
        } catch (error) {
          answers.push({ threw: { name: error && error.name, message: String((error && error.message) || error) } });
        }
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      // `undefined` would be dropped from the JSON, so a call that returned nothing says so.
      const returned = answers.map((answer) => ("returned" in answer && answer.returned === undefined ? { returnedNothing: true } : answer));
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ calls: returned, events: events.filter((event) => event && event.name !== "stateUpdate" && event.name !== "workflowUpdated"), loads }),
      };
    },
  };
}
