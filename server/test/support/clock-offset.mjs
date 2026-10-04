// Preloaded by startTestServer({ clockOffsetMs }), so the server's Date runs
// that far from real time, as on a host whose clock has drifted. Timers and
// performance.now() keep real time.

const offset = Number(process.env.TEST_CLOCK_OFFSET_MS);
const RealDate = globalThis.Date;
const now = () => RealDate.now() + offset;

globalThis.Date = new Proxy(RealDate, {
  construct: (target, args, newTarget) => Reflect.construct(target, args.length > 0 ? args : [now()], newTarget),
  apply: () => new RealDate(now()).toString(),
  get: (target, property, receiver) => (property === "now" ? now : Reflect.get(target, property, receiver)),
});
