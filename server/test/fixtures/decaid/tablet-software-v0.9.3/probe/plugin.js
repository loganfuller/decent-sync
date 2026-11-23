// A plugin that makes the `host.localApi` calls it is asked to, one after another, and answers with what each
// resolved to or was rejected with (README.md beside record.mjs). Installed on a throwaway Decaid only.
function createPlugin(host) {
  return {
    id: "localapi-probe.reaplugin",
    version: "0.0.1",
    onLoad(settings) {
      host.log("localApi probe loaded with " + JSON.stringify(settings || {}));
    },
    onUnload() {},
    onEvent() {},
    __httpRequestHandler: async (request) => {
      const calls = (request.body && request.body.calls) || [];
      const answers = [];
      for (const call of calls) {
        try {
          answers.push({ resolved: await host.localApi(call.path, call.options) });
        } catch (error) {
          answers.push({ rejected: { name: error && error.name, message: String((error && error.message) || error) } });
        }
      }
      return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(answers) };
    },
  };
}
